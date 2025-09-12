// server.js
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const BULK_FILE  = path.join('/tmp', 'shopify-bulk.ndjson');

// ------------- helpers básicos -------------
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
              quantities(names: ["available"]) {
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
function buildBulkQueryOptimized({ search = null } = {}) {
  // Ojo: el query de inventoryItems solo admite filtros limitados (p.ej. sku:, updated_at:).
  // Ejemplos válidos:
  //   search = 'updated_at:>=2025-09-11'
  //   search = 'sku:ABC*'
  const qArg = search ? `(query: ${JSON.stringify(search)})` : '';

  return `
  {
    inventoryItems${qArg} {
      edges {
        node {
          id
          sku
          variant {
            id
            product { id }
          }
          inventoryLevels {
            edges {
              node {
                location { id }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }`;
}

// ------------- cache de locations -------------
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

// ------------- lógica de corrección (si quieres mantenerla) -------------
function shouldFix(map, raise = false) {
  const onHand    = map.on_hand ?? 0;
  const available = map.available ?? 0;
  const committed = map.committed ?? 0;
  const incoming  = map.incoming  ?? 0;
  if (onHand < 0) return true;
  if (available < 0 && incoming === 0) {
    if (!raise) return committed === 0;
    return true;
  }
  return false;
}

async function applyBatches(corrections, reason = 'correction') {
  const BATCH = 200;
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

app.get('/locations-cache', async (_req, res) => {
  try {
    const map = await getLocationMap();
    res.json({ ok: true, count: map.size, items: Array.from(map.entries()) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ------------- BULK por slices -------------
app.post('/bulk-start', async (req, res) => {
  try {
    const q = req.query.q || null;
    // La nueva query solo devuelve 'available', así que el parámetro 'names' ya no es necesario.
    const query = buildBulkQueryOptimized({ search: q }); // <-- CAMBIO AQUÍ
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

// ------------- CSV estilo Matrixify -------------
app.get('/bulk-to-csv', async (_req, res) => {
  try {
    if (!fs.existsSync(BULK_FILE)) {
      return res.status(400).json({ ok:false, error:'No hay archivo NDJSON. Ejecuta /bulk-download antes.' });
    }

    const text = fs.readFileSync(BULK_FILE, 'utf8');
    const locMap = await getLocationMap();           // id -> name
    const locIds = Array.from(locMap.keys());
    const locNames = locIds.map(id => locMap.get(id));

    // Cabeceras estilo Matrixify
    const headers = ['ID', 'Variant ID', ...locNames.map(n => `Inventory Available: ${n}`)];

    // Índices temporales
    // invIndex: inventoryItemId -> { variantId, productId }
    const invIndex = new Map();
    // variantRows: variantId -> { productId, variantId, levels:{[locId]: available} }
    const variantRows = new Map();

    // 1ª pasada: recoger inventoryItems (líneas sin __parentId y con "variant")
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

    // 2ª pasada: recoger inventoryLevels (líneas HIJO con __parentId)
    for (const obj of parseNdjsonLines(text)) {
      if (!obj) continue;

      // Un nodo de nivel típico trae __parentId + location + quantities
      const parent = obj.__parentId;
      const hasLevelShape = parent && obj.location && (Array.isArray(obj.quantities) || obj.quantities === null || obj.quantities === undefined);

      if (!hasLevelShape) continue;

      const invMeta = invIndex.get(parent);
      if (!invMeta) continue; // podría ser otro tipo de hijo que no nos interesa

      const locId = obj.location?.id;
      if (!locId) continue;

      // Cantidad "available": en tu query viene como array de {name,quantity}
      const availableEntry = (obj.quantities || []).find(q => q.name === 'available');
      const available = availableEntry ? (availableEntry.quantity ?? 0) : 0;

      const row = variantRows.get(invMeta.variantId) || { productId: invMeta.productId, variantId: invMeta.variantId, levels: {} };
      row.levels[locId] = available;
      variantRows.set(invMeta.variantId, row);
    }

    // Construcción CSV
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
