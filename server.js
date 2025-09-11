// server.js
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP = process.env.SHOPIFY_SHOP;               // p.ej. silbon-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;       // shpat_****
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BULK_FILE = path.join('/tmp', 'shopify-bulk.ndjson'); // Render: /tmp es válido

function toGidVariant(idOrGid) {
  const s = String(idOrGid || '');
  return s.startsWith('gid://') ? s : `gid://shopify/ProductVariant/${s}`;
}

async function shopifyGraphQL(query, variables = {}) {
  if (!SHOP || !TOKEN) throw new Error('Faltan SHOPIFY_SHOP o SHOPIFY_ADMIN_TOKEN');
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL errors: ' + JSON.stringify(json.errors));
  return json.data;
}

// ===== QUERIES / MUTATIONS (LIVE) =====
const VARIANT_WITH_LEVELS = `
  query VariantWithLevels($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      product { id }
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 100) {
          edges {
            node {
              location { id }
              quantities(names: ["on_hand","available","committed","incoming"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCTS_VARIANT_IDS = `
  query ProductsVariantIds($cursor: String) {
    products(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          variants(first: 100) {
            edges { node { id sku } }
          }
        }
      }
    }
  }
`;

const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes { name delta }
      }
    }
  }
`;

// ===== BULK OPS =====
const BULK_RUN = `
  mutation bulkOp($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const BULK_STATUS = `
  query {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
    }
  }
`;

const BULK_CANCEL_WITH_ID = `
  mutation bulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) { userErrors { field message } }
  }
`;

/**
 * Bulk minimalísima (rápida):
 * - product { id }
 * - variant { id, sku }
 * - inventoryItem { id }
 * - inventoryLevels { location { id }, quantities(on_hand,available,committed,incoming) }
 * Sin títulos ni location.name para bajar el objectCount.
 * Se puede particionar con ?q=... (search) de Shopify (title, vendor, product_type, updated_at, etc.)
 */
function buildBulkQuery({ search = null } = {}) {
  const queryArg = search ? `(query: ${JSON.stringify(search)})` : '';
  return `
  {
    products${queryArg} {
      edges {
        node {
          id
          variants(first: 250) {
            edges {
              node {
                id
                sku
                inventoryItem {
                  id
                  inventoryLevels {
                    edges {
                      node {
                        location { id }
                        quantities(names: ["on_hand","available","committed","incoming"]) {
                          name
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;
}

// ===== HELPERS =====
function mapQuantities(qs) {
  return Object.fromEntries(qs.map(q => [q.name, q.quantity]));
}

// raise = true -> si available<0 pero committed>0, subimos on_hand a committed
function shouldFix(map, raise = false) {
  const onHand = map.on_hand ?? 0;
  const available = map.available ?? 0;
  const committed = map.committed ?? 0;
  const incoming = map.incoming ?? 0;
  return (onHand < 0) || (available < 0 && (committed === 0 || (raise && committed > 0)) && incoming === 0);
}

// Trae niveles de UNA variante (live)
async function fetchVariantLevels(variantIdGid) {
  const data = await shopifyGraphQL(VARIANT_WITH_LEVELS, { id: variantIdGid });
  return data.productVariant || null;
}

// Escaneo live limitado (pages/concurrency) para pruebas rápidas
async function scanAllNegatives({ excludeLocationContains, maxPages = null, concurrency = 5, raise = false } = {}) {
  let cursor = null, hasNext = true;
  const corrections = [];
  const CONCURRENCY = Math.max(1, Number(concurrency) || 5);
  const queue = [];
  let pages = 0;

  async function processVariant(vNode, productId) {
    const v = await fetchVariantLevels(vNode.id);
    if (!v?.inventoryItem?.tracked) return;

    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      if (excludeLocationContains && String(lvl.location.id).includes(excludeLocationContains)) continue;
      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m, raise)) {
        const target = (raise && (m.committed ?? 0) > 0) ? (m.committed ?? 0) : 0;
        corrections.push({
          inventoryItemId: v.inventoryItem.id,
          locationId: lvl.location.id,
          setOnHandTo: target,
          meta: {
            productId,
            variantId: v.id,
            sku: v.sku || vNode.sku || 'NO-SKU',
            before: {
              onHand: m.on_hand ?? 0,
              available: m.available ?? 0,
              committed: m.committed ?? 0,
              incoming: m.incoming ?? 0
            }
          }
        });
      }
    }
  }

  while (hasNext) {
    if (maxPages && pages >= maxPages) break;
    pages++;

    const data = await shopifyGraphQL(PRODUCTS_VARIANT_IDS, { cursor });
    const { edges, pageInfo } = data.products;
    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;

    for (const pe of edges) {
      const productId = pe.node.id;
      for (const ve of pe.node.variants.edges) {
        const p = processVariant(ve.node, productId).catch(() => {});
        queue.push(p);
        if (queue.length >= CONCURRENCY) {
          await Promise.race(queue);
          for (let i = queue.length - 1; i >= 0; i--) if (queue[i].settled) queue.splice(i, 1);
        }
        p.finally(() => { p.settled = true; });
      }
    }
  }

  await Promise.allSettled(queue);
  return corrections;
}

async function applyBatches(corrections, reason = 'correction') {
  const BATCH = 200; // límite seguro
  const results = [];
  for (let i = 0; i < corrections.length; i += BATCH) {
    const batch = corrections.slice(i, i + BATCH);
    const input = {
      reason,
      setQuantities: batch.map(c => ({
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
        quantity: (typeof c.setOnHandTo === 'number') ? c.setOnHandTo : 0
      }))
    };
    const resp = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    results.push(resp.inventorySetOnHandQuantities);
    await new Promise(r => setTimeout(r, 200)); // respira
  }
  return results;
}

// ===== NDJSON utils (Bulk) =====
function* parseNdjsonLines(str) {
  const lines = str.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* ignora línea corrupta */ }
  }
}

/**
 * node shape (bulk minimal):
 * {
 *   id: "gid://shopify/Product/...",
 *   variants: { edges: [ { node: {
 *      id, sku,
 *      inventoryItem: {
 *        id,
 *        inventoryLevels: { edges: [ { node: { location:{id}, quantities:[...] } } ] }
 *      }
 *   }} ] }
 * }
 */
function collectCorrectionsFromBulkProductNode(productNode, { excludeLocationIdContains, raise }) {
  const out = [];
  const variants = productNode?.variants?.edges || [];
  for (const ve of variants) {
    const v = ve?.node;
    if (!v?.inventoryItem) continue;

    const levels = v.inventoryItem.inventoryLevels?.edges || [];
    for (const e of levels) {
      const lvl = e.node;
      if (!lvl) continue;
      const locId = lvl.location?.id;
      if (excludeLocationIdContains && String(locId || '').includes(excludeLocationIdContains)) continue;

      const m = Object.fromEntries((lvl.quantities || []).map(q => [q.name, q.quantity]));
      const onHand = m.on_hand ?? 0;
      const available = m.available ?? 0;
      const committed = m.committed ?? 0;
      const incoming = m.incoming ?? 0;

      const fixable = (onHand < 0) || (available < 0 && (committed === 0 || (raise && committed > 0)) && incoming === 0);
      if (!fixable) continue;

      const target = (raise && committed > 0) ? committed : 0;
      out.push({
        inventoryItemId: v.inventoryItem.id,
        locationId: locId,
        setOnHandTo: target,
        meta: {
          productId: productNode.id,
          variantId: v.id,
          sku: v.sku || 'NO-SKU',
          before: { onHand, available, committed, incoming }
        }
      });
    }
  }
  return out;
}

// ===== ROUTES =====
app.get('/health', (_, res) => res.send('OK'));
app.get('/env-check', (_, res) => {
  res.json({
    SHOPIFY_SHOP: process.env.SHOPIFY_SHOP || null,
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || null,
    HAS_TOKEN: !!process.env.SHOPIFY_ADMIN_TOKEN
  });
});

// === LIVE (para pruebas pequeñas) ===
app.get('/variant-dry', async (req, res) => {
  try {
    const { variantId, variantGid, raise } = req.query;
    const gid = toGidVariant(variantGid || variantId);
    if (!variantId && !variantGid) return res.status(400).json({ ok: false, error: 'Falta ?variantId= o ?variantGid=' });

    const v = await fetchVariantLevels(gid);
    if (!v) return res.status(404).json({ ok: false, error: 'Variante no encontrada' });
    if (!v.inventoryItem?.tracked) return res.json({ ok: true, toFixCount: 0, note: 'inventoryItem no tracked' });

    const items = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m, raise === '1')) {
        const target = (raise === '1' && (m.committed ?? 0) > 0) ? (m.committed ?? 0) : 0;
        items.push({
          inventoryItemId: v.inventoryItem.id,
          variantId: v.id,
          sku: v.sku || 'NO-SKU',
          productId: v.product?.id,
          locationId: lvl.location.id,
          setOnHandTo: target,
          before: { onHand: m.on_hand ?? 0, available: m.available ?? 0, committed: m.committed ?? 0, incoming: m.incoming ?? 0 }
        });
      }
    }
    res.json({ ok: true, mode: 'dry-run', toFixCount: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/variant-fix', async (req, res) => {
  try {
    const { variantId, variantGid, raise } = req.query;
    const gid = toGidVariant(variantGid || variantId);
    if (!variantId && !variantGid) return res.status(400).json({ ok: false, error: 'Falta ?variantId= o ?variantGid=' });

    const v = await fetchVariantLevels(gid);
    if (!v) return res.status(404).json({ ok: false, error: 'Variante no encontrada' });
    if (!v.inventoryItem?.tracked) return res.json({ ok: true, fixedCount: 0, note: 'inventoryItem no tracked' });

    const setQuantities = [];
    const report = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m, raise === '1')) {
        const target = (raise === '1' && (m.committed ?? 0) > 0) ? (m.committed ?? 0) : 0;
        setQuantities.push({ inventoryItemId: v.inventoryItem.id, locationId: lvl.location.id, quantity: target });
        report.push({ locationId: lvl.location.id, setOnHandTo: target, before: { onHand: m.on_hand ?? 0, available: m.available ?? 0, committed: m.committed ?? 0, incoming: m.incoming ?? 0 } });
      }
    }

    if (setQuantities.length === 0) return res.json({ ok: true, fixedCount: 0, message: 'La variante no tiene negativos 👌' });

    const input = { reason: 'correction', setQuantities };
    const resp = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    const errs = resp.inventorySetOnHandQuantities.userErrors || [];
    if (errs.length) return res.status(400).json({ ok: false, userErrors: errs, attempted: report });

    res.json({ ok: true, fixedCount: setQuantities.length, report });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/auto-dry', async (req, res) => {
  try {
    const exclude = req.query.exclude || null;
    const pages = req.query.pages ? Number(req.query.pages) : null;
    const c = req.query.c ? Number(req.query.c) : 5;
    const raise = req.query.raise === '1';
    const corrections = await scanAllNegatives({ excludeLocationContains: exclude, maxPages: pages, concurrency: c, raise });
    res.json({ ok: true, mode: 'dry-run', toFixCount: corrections.length, sample: corrections.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/auto-fix', async (req, res) => {
  try {
    const exclude = req.query.exclude || null;
    const pages = req.query.pages ? Number(req.query.pages) : null;
    const c = req.query.c ? Number(req.query.c) : 5;
    const raise = req.query.raise === '1';
    const corrections = await scanAllNegatives({ excludeLocationContains: exclude, maxPages: pages, concurrency: c, raise });
    if (corrections.length === 0) return res.json({ ok: true, fixedCount: 0, message: 'No hay negativos que corregir 👌' });

    const results = await applyBatches(corrections, 'correction');
    res.json({ ok: true, fixedCount: corrections.length, batches: results.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === BULK ROUTES (rápidas y particionables) ===

// Lanzar bulk (GET o POST). Permite ?q=... (search de Shopify).
app.get('/bulk-start', async (req, res) => {
  try {
    const q = req.query.q || null; // ej: updated_at:>=2025-09-01
    const query = buildBulkQuery({ search: q });
    const data = await shopifyGraphQL(BULK_RUN, { query });
    const errs = data.bulkOperationRunQuery.userErrors || [];
    if (errs.length) return res.status(400).json({ ok: false, userErrors: errs });
    res.json({ ok: true, started: data.bulkOperationRunQuery.bulkOperation, filter: q || null });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});
app.post('/bulk-start', async (req, res) => {
  try {
    const q = req.query.q || null;
    const query = buildBulkQuery({ search: q });
    const data = await shopifyGraphQL(BULK_RUN, { query });
    const errs = data.bulkOperationRunQuery.userErrors || [];
    if (errs.length) return res.status(400).json({ ok: false, userErrors: errs });
    res.json({ ok: true, started: data.bulkOperationRunQuery.bulkOperation, filter: q || null });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/bulk-status', async (_req, res) => {
  try {
    const data = await shopifyGraphQL(BULK_STATUS);
    res.json({ ok: true, status: data.currentBulkOperation });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post('/bulk-cancel', async (_req, res) => {
  try {
    const st = await shopifyGraphQL(BULK_STATUS);
    const op = st.currentBulkOperation;
    if (!op || op.status !== 'RUNNING') return res.json({ ok:true, message:'No hay BULK RUNNING que cancelar', status: op || null });
    const data = await shopifyGraphQL(BULK_CANCEL_WITH_ID, { id: op.id });
    const errs = data.bulkOperationCancel.userErrors || [];
    if (errs.length) return res.status(400).json({ ok:false, userErrors: errs });
    res.json({ ok:true, cancelled: op.id });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/bulk-download', async (_req, res) => {
  try {
    const st = await shopifyGraphQL(BULK_STATUS);
    const op = st.currentBulkOperation;
    if (!op || op.status !== 'COMPLETED' || !op.url) {
      return res.status(400).json({ ok:false, error:'Bulk no está COMPLETED o no hay url', status: op || null });
    }
    const r = await fetch(op.url);
    if (!r.ok) throw new Error(`descarga bulk falló: ${r.status}`);
    const text = await r.text();
    fs.writeFileSync(BULK_FILE, text, 'utf8');
    res.json({ ok:true, savedTo: BULK_FILE, bytes: Buffer.byteLength(text, 'utf8'), objectCount: op.objectCount });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// bulk-dry con límites y filtros (emula pages=1)
app.get('/bulk-dry', async (req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) return res.status(400).json({ ok:false, error:'No se encuentra el archivo bulk. Ejecuta /bulk-download primero.' });

    const text = fs.readFileSync(BULK_FILE, 'utf8');
    const raise = req.query.raise === '1';
    const limitVariants = req.query.limitVariants ? Number(req.query.limitVariants) : null;   // ej: 20
    const maxCorrections = req.query.maxCorrections ? Number(req.query.maxCorrections) : null; // ej: 50
    const onlyVariantId = req.query.onlyVariantId || null;
    const excludeVariantId = req.query.excludeVariantId || null;
    const filterSku = (req.query.filterSku || '').toLowerCase();
    const excludeLocationIdContains = req.query.exclude || null; // usa substring de locationId

    const corrections = [];
    let variantsSeen = 0;

    for (const obj of parseNdjsonLines(text)) {
      const productNode = obj?.id && obj?.variants ? obj : obj?.node || obj;
      if (!productNode?.id) continue;

      const vEdges = productNode.variants?.edges || [];
      for (const ve of vEdges) {
        const v = ve?.node;
        if (!v?.id || !v?.inventoryItem) continue;

        if (onlyVariantId && v.id !== onlyVariantId) continue;
        if (excludeVariantId && v.id === excludeVariantId) continue;
        if (filterSku && !(String(v.sku || '').toLowerCase().includes(filterSku))) continue;

        variantsSeen++;
        if (limitVariants && variantsSeen > limitVariants) break;

        const items = collectCorrectionsFromBulkProductNode(
          { id: productNode.id, variants: { edges: [ { node: v } ] } },
          { excludeLocationIdContains, raise }
        );
        for (const it of items) {
          corrections.push(it);
          if (maxCorrections && corrections.length >= maxCorrections) {
            return res.json({ ok:true, mode:'dry-run (bulk file)', toFixCount: corrections.length, sample: corrections });
          }
        }
      }
      if (limitVariants && variantsSeen >= limitVariants) break;
    }

    res.json({ ok:true, mode:'dry-run (bulk file)', toFixCount: corrections.length, sample: corrections.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// bulk-fix (desde archivo) con límites/filtros
app.get('/bulk-fix', async (req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) return res.status(400).json({ ok:false, error:'No se encuentra el archivo bulk. Ejecuta /bulk-download primero.' });

    const text = fs.readFileSync(BULK_FILE, 'utf8');
    const raise = req.query.raise === '1';
    const limitVariants = req.query.limitVariants ? Number(req.query.limitVariants) : null;
    const maxCorrections = req.query.maxCorrections ? Number(req.query.maxCorrections) : null;
    const onlyVariantId = req.query.onlyVariantId || null;
    const excludeVariantId = req.query.excludeVariantId || null;
    const filterSku = (req.query.filterSku || '').toLowerCase();
    const excludeLocationIdContains = req.query.exclude || null;

    const corrections = [];
    let variantsSeen = 0;

    for (const obj of parseNdjsonLines(text)) {
      const productNode = obj?.id && obj?.variants ? obj : obj?.node || obj;
      if (!productNode?.id) continue;

      const vEdges = productNode.variants?.edges || [];
      for (const ve of vEdges) {
        const v = ve?.node;
        if (!v?.id || !v?.inventoryItem) continue;

        if (onlyVariantId && v.id !== onlyVariantId) continue;
        if (excludeVariantId && v.id === excludeVariantId) continue;
        if (filterSku && !(String(v.sku || '').toLowerCase().includes(filterSku))) continue;

        variantsSeen++;
        if (limitVariants && variantsSeen > limitVariants) break;

        const items = collectCorrectionsFromBulkProductNode(
          { id: productNode.id, variants: { edges: [ { node: v } ] } },
          { excludeLocationIdContains, raise }
        );
        for (const it of items) {
          corrections.push(it);
          if (maxCorrections && corrections.length >= maxCorrections) break;
        }
      }
      if ((limitVariants && variantsSeen >= limitVariants) || (maxCorrections && corrections.length >= maxCorrections)) break;
    }

    if (corrections.length === 0) return res.json({ ok:true, fixedCount: 0, message: 'Nada que corregir con los filtros/límites dados.' });

    const results = await applyBatches(corrections, 'correction');
    res.json({ ok:true, fixedCount: corrections.length, batches: results.length, sample: corrections.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
