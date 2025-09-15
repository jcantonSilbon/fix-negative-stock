// server.js
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;                 // p.ej. silbon-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;          // shpat_****
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const BULK_FILE  = path.join('/tmp', 'shopify-bulk.ndjson');

// ------------- helpers -------------
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

function* parseNdjsonLines(str) {
  const lines = str.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

// ------------- queries/mutations -------------
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
              quantities(names: ["available"]) { name quantity }
            }
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
      inventoryAdjustmentGroup { createdAt reason changes { name delta } }
    }
  }
`;

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
      id status errorCode createdAt completedAt objectCount fileSize url
    }
  }
`;

const BULK_CANCEL_WITH_ID = `
  mutation bulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) { userErrors { field message } }
  }
`;

const LOCATIONS_QUERY = `
  query {
    locations(first: 250) {
      edges { node { id name } }
    }
  }
`;

// ------------- bulk minimal “Matrixify-like” -------------
// lite=1 → no pedir sku para reducir bytes.
// search admite: updated_at:>=YYYY-MM-DD, sku:A*, vendor:"ACME", etc.
function buildBulkQueryOptimized({ search = null, lite = false } = {}) {
  const qArg = search ? `(query: ${JSON.stringify(search)})` : '';
  return `
  {
    inventoryItems${qArg} {
      edges {
        node {
          id
          ${lite ? '' : 'sku'}
          variant {
            id
            product { id status }
          }
          inventoryLevels {
            edges {
              node {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }`;
}

// ------------- cache de locations (para cabeceras CSV) -------------
let _locCache = { map: new Map(), at: 0 };
async function getLocationMap() {
  const now = Date.now();
  if (_locCache.map.size && (now - _locCache.at) < 60 * 60 * 1000) return _locCache.map; // 1h
  const data = await shopifyGraphQL(LOCATIONS_QUERY);
  const map = new Map();
  for (const e of (data.locations?.edges || [])) {
    const n = e.node;
    map.set(n.id, n.name);
  }
  _locCache = { map, at: now };
  return map;
}

// ------------- aplicar correcciones -------------
async function applyBatches(corrections, reason = 'fix-negative-available') {
  const BATCH = 200;
  const results = [];
  for (let i = 0; i < corrections.length; i += BATCH) {
    const batch = corrections.slice(i, i + BATCH);
    const input = {
      reason,
      setQuantities: batch.map(c => ({
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
        quantity: 0 // siempre a 0 para negativos
      }))
    };
    const resp = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    results.push(resp.inventorySetOnHandQuantities);
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ------------- routes básicas -------------
app.get('/health', (_, res) => res.send('OK'));
app.get('/env-check', (_, res) => {
  res.json({
    SHOPIFY_SHOP: process.env.SHOPIFY_SHOP || null,
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || null,
    HAS_TOKEN: !!process.env.SHOPIFY_ADMIN_TOKEN
  });
});

// ------------- BULK control -------------
app.post('/bulk-start', async (req, res) => {
  try {
    const q = req.query.q || null;       // e.g. updated_at:>=2025-09-11, sku:A*, vendor:"SILBON"
    const lite = req.query.lite === '1'; // menos bytes
    const query = buildBulkQueryOptimized({ search: q, lite });
    const data = await shopifyGraphQL(BULK_RUN, { query });
    const errs = data.bulkOperationRunQuery.userErrors || [];
    if (errs.length) return res.status(400).json({ ok: false, userErrors: errs });
    res.json({ ok: true, started: data.bulkOperationRunQuery.bulkOperation, filter: q || null, lite });
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
    if (!op || (op.status !== 'RUNNING' && op.status !== 'CREATED')) {
      return res.json({ ok:true, message:'No hay BULK RUNNING/CREATED que cancelar', status: op || null });
    }
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

// ------------- PLAN: detectar negativos en NDJSON -------------
app.get('/bulk-plan-negatives', async (_req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) {
      return res.status(400).json({ ok:false, error:'No hay NDJSON. Ejecuta /bulk-download antes.' });
    }
    const text = fs.readFileSync(BULK_FILE, 'utf8');

    // index inv → meta
    const invIndex = new Map();
    for (const obj of parseNdjsonLines(text)) {
      if (obj?.variant && !obj.__parentId) {
        invIndex.set(obj.id, {
          inventoryItemId: obj.id,
          variantId: obj.variant?.id || null,
          productId: obj.variant?.product?.id || null,
          status: obj.variant?.product?.status || null,
          sku: obj.sku || null
        });
      }
    }

    const negatives = [];
    for (const obj of parseNdjsonLines(text)) {
      if (!obj?.__parentId || !obj?.location) continue;
      const meta = invIndex.get(obj.__parentId);
      if (!meta) continue;

      const available = (obj.quantities || []).find(q => q.name === 'available')?.quantity ?? 0;
      if (available < 0) {
        negatives.push({
          ...meta,
          locationId: obj.location.id,
          available
        });
      }
    }

    const byStatus = negatives.reduce((acc, n) => {
      const s = n.status || 'UNKNOWN';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    res.json({ ok:true, count: negatives.length, byStatus, sample: negatives.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ------------- FIX: poner negativos a 0 -------------
app.post('/bulk-fix-negatives', async (req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) {
      return res.status(400).json({ ok:false, error:'No hay NDJSON. Ejecuta /bulk-download antes.' });
    }
    const text = fs.readFileSync(BULK_FILE, 'utf8');

    // index inv → meta
    const invIndex = new Map();
    for (const obj of parseNdjsonLines(text)) {
      if (obj?.variant && !obj.__parentId) {
        invIndex.set(obj.id, {
          inventoryItemId: obj.id,
          variantId: obj.variant?.id || null,
          productId: obj.variant?.product?.id || null
        });
      }
    }

    const corrections = [];
    for (const obj of parseNdjsonLines(text)) {
      if (!obj?.__parentId || !obj?.location) continue;
      const meta = invIndex.get(obj.__parentId);
      if (!meta) continue;

      const available = (obj.quantities || []).find(q => q.name === 'available')?.quantity ?? 0;
      if (available < 0) {
        corrections.push({
          inventoryItemId: meta.inventoryItemId,
          locationId: obj.location.id,
          setOnHandTo: 0
        });
      }
    }

    if (!corrections.length) return res.json({ ok:true, message:'No hay negativos que corregir.' });

    const reason = (req.query.reason || 'fix-negative-available').toString();
    const results = await applyBatches(corrections, reason);
    res.json({ ok:true, corrected: corrections.length, batches: results.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ------------- CSV estilo Matrixify (opcional) -------------
app.get('/bulk-to-csv', async (_req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) {
      return res.status(400).json({ ok:false, error:'No hay archivo NDJSON. Ejecuta /bulk-download antes.' });
    }
    const text = fs.readFileSync(BULK_FILE, 'utf8');
    const locMap = await getLocationMap();
    const locIds = Array.from(locMap.keys());
    const locNames = locIds.map(id => locMap.get(id));
    const headers = ['ID', 'Variant ID', ...locNames.map(n => `Inventory Available: ${n}`)];

    const invIndex = new Map();     // invId -> { variantId, productId }
    const variantRows = new Map();  // variantId -> { productId, variantId, levels:{} }

    // 1ª pasada: inventoryItems
    for (const obj of parseNdjsonLines(text)) {
      if (!obj) continue;
      const isInventoryItem = obj.variant && !obj.__parentId;
      if (isInventoryItem) {
        const inventoryItemId = obj.id;
        const variantId = obj.variant?.id || null;
        const productId = obj.variant?.product?.id || null;
        if (!inventoryItemId || !variantId) continue;

        invIndex.set(inventoryItemId, { variantId, productId });
        if (!variantRows.has(variantId)) {
          variantRows.set(variantId, { productId, variantId, levels: {} });
        }
      }
    }

    // 2ª pasada: inventoryLevels
    for (const obj of parseNdjsonLines(text)) {
      if (!obj) continue;
      const parent = obj.__parentId;
      const hasLevelShape = parent && obj.location && (Array.isArray(obj.quantities) || obj.quantities == null);
      if (!hasLevelShape) continue;

      const invMeta = invIndex.get(parent);
      if (!invMeta) continue;

      const locId = obj.location?.id;
      if (!locId) continue;

      const availableEntry = (obj.quantities || []).find(q => q.name === 'available');
      const available = availableEntry ? (availableEntry.quantity ?? 0) : 0;

      const row = variantRows.get(invMeta.variantId);
      row.levels[locId] = available;
    }

    // CSV
    let out = '';
    out += headers.join(',') + '\n';
    for (const [, rec] of variantRows) {
      const line = [
        rec.productId || '',
        rec.variantId || '',
        ...locIds.map(id => (rec.levels[id] == null ? '' : String(rec.levels[id])))
      ];
      out += line.join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory_available.csv"');
    res.send(out);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ------------- variante puntual (diagnóstico rápido) -------------
app.get('/variant-dry', async (req, res) => {
  try {
    const { variantId, variantGid } = req.query;
    const gid = toGidVariant(variantGid || variantId);
    if (!variantId && !variantGid) return res.status(400).json({ ok: false, error: 'Falta ?variantId= o ?variantGid=' });

    const v = await shopifyGraphQL(VARIANT_WITH_LEVELS, { id: gid }).then(d => d.productVariant);
    if (!v) return res.status(404).json({ ok: false, error: 'Variante no encontrada' });
    if (!v.inventoryItem?.tracked) return res.json({ ok: true, toFixCount: 0, note: 'inventoryItem no tracked' });

    const items = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const available = (lvl.quantities || []).find(q => q.name === 'available')?.quantity ?? 0;
      if (available < 0) {
        items.push({
          inventoryItemId: v.inventoryItem.id,
          variantId: v.id,
          productId: v.product?.id,
          locationId: lvl.location.id,
          setOnHandTo: 0,
          before: { available }
        });
      }
    }
    res.json({ ok: true, mode: 'dry-run', toFixCount: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
