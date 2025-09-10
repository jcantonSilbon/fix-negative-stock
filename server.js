// server.js
import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP = process.env.SHOPIFY_SHOP;               // p.ej. silbon-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;       // shpat_****
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';

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

// ===== QUERIES / MUTATIONS =====
const VARIANT_WITH_LEVELS = `
  query VariantWithLevels($id: ID!) {
    productVariant(id: $id) {
      id
      sku
      product { title }
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 100) {
          edges {
            node {
              location { id name }
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

// Query ligera: productos -> IDs de variantes (sin niveles)
const PRODUCTS_VARIANT_IDS = `
  query ProductsVariantIds($cursor: String) {
    products(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
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

// ===== HELPERS =====
function mapQuantities(qs) {
  return Object.fromEntries(qs.map(q => [q.name, q.quantity]));
}
function shouldFix(map) {
  const onHand = map.on_hand ?? 0;
  const available = map.available ?? 0;
  const committed = map.committed ?? 0;
  const incoming = map.incoming ?? 0;
  return onHand < 0 || (available < 0 && committed === 0 && incoming === 0);
}

// Trae niveles de UNA variante (usa VARIANT_WITH_LEVELS)
async function fetchVariantLevels(variantIdGid) {
  const data = await shopifyGraphQL(VARIANT_WITH_LEVELS, { id: variantIdGid });
  return data.productVariant || null;
}

// Escaneo global evitando coste excesivo: productos -> IDs variantes -> niveles por variante
async function scanAllNegatives({ excludeLocationContains, maxPages = null, concurrency = 5, raise = false } = {}) {
  let cursor = null, hasNext = true;
  const corrections = [];

  const CONCURRENCY = Math.max(1, Number(concurrency) || 5);
  const queue = [];
  let pages = 0;

  async function processVariant(vNode, productTitle) {
    const v = await fetchVariantLevels(vNode.id);
    if (!v?.inventoryItem?.tracked) return;

    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      if (excludeLocationContains && lvl.location.name?.includes(excludeLocationContains)) continue;

      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m)) {
        const target = (raise && (m.committed ?? 0) > 0) ? (m.committed ?? 0) : 0;
        corrections.push({
          inventoryItemId: v.inventoryItem.id,
          locationId: lvl.location.id,
          setOnHandTo: target,
          meta: {
            variantId: v.id,
            sku: v.sku || vNode.sku || 'NO-SKU',
            productTitle,
            locationName: lvl.location.name,
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
      const productTitle = pe.node.title;
      for (const ve of pe.node.variants.edges) {
        const p = processVariant(ve.node, productTitle).catch(() => {});
        queue.push(p);
        if (queue.length >= CONCURRENCY) {
          await Promise.race(queue);
          // limpia resueltas
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].settled) queue.splice(i, 1);
          }
        }
        // marca settled para limpieza simple
        p.finally(() => { p.settled = true; });
      }
    }
  }

  // espera a que acaben todas
  await Promise.allSettled(queue);
  return corrections;
}

async function applyBatches(corrections, reason = 'correction') {
  const BATCH = 200; // bajo el límite (250)
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
      // referenceDocumentUri opcional si quieres dejar rastro externo
    };
    const resp = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    results.push(resp.inventorySetOnHandQuantities);

    // pequeño respiro para ir suaves con el API
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
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

// ---- Variante: dry ----
app.get('/variant-dry', async (req, res) => {
  try {
    const { variantId, variantGid } = req.query;
    const gid = toGidVariant(variantGid || variantId);
    if (!variantId && !variantGid) {
      return res.status(400).json({ ok: false, error: 'Falta ?variantId= o ?variantGid=' });
    }

    const data = await shopifyGraphQL(VARIANT_WITH_LEVELS, { id: gid });
    const v = data.productVariant;
    if (!v) return res.status(404).json({ ok: false, error: 'Variante no encontrada' });
    if (!v.inventoryItem?.tracked) return res.json({ ok: true, toFixCount: 0, note: 'inventoryItem no tracked' });

    const items = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m)) {
        items.push({
          inventoryItemId: v.inventoryItem.id,
          variantId: v.id,
          sku: v.sku || 'NO-SKU',
          productTitle: v.product?.title || '',
          locationId: lvl.location.id,
          locationName: lvl.location.name,
          setOnHandTo: 0,
          before: { onHand: m.on_hand ?? 0, available: m.available ?? 0, committed: m.committed ?? 0, incoming: m.incoming ?? 0 }
        });
      }
    }
    res.json({ ok: true, mode: 'dry-run', toFixCount: items.length, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Variante: fix ----
app.get('/variant-fix', async (req, res) => {
  try {
    const { variantId, variantGid, raise } = req.query;
    const gid = toGidVariant(variantGid || variantId);
    if (!variantId && !variantGid) {
      return res.status(400).json({ ok: false, error: 'Falta ?variantId= o ?variantGid=' });
    }

    const data = await shopifyGraphQL(VARIANT_WITH_LEVELS, { id: gid });
    const v = data.productVariant;
    if (!v) return res.status(404).json({ ok: false, error: 'Variante no encontrada' });
    if (!v.inventoryItem?.tracked) return res.json({ ok: true, fixedCount: 0, note: 'inventoryItem no tracked' });

    const setQuantities = [];
    const report = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const m = mapQuantities(lvl.quantities);
      if (shouldFix(m)) {
        const target = (raise === '1' && (m.committed ?? 0) > 0) ? (m.committed ?? 0) : 0;
        setQuantities.push({ inventoryItemId: v.inventoryItem.id, locationId: lvl.location.id, quantity: target });
        report.push({
          locationId: lvl.location.id,
          locationName: lvl.location.name,
          before: { onHand: m.on_hand ?? 0, available: m.available ?? 0, committed: m.committed ?? 0, incoming: m.incoming ?? 0 },
          setOnHandTo: target
        });
      }
    }

    if (setQuantities.length === 0) return res.json({ ok: true, fixedCount: 0, message: 'La variante no tiene negativos 👌' });

    const input = { reason: 'correction', setQuantities };
    const resp = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    const errs = resp.inventorySetOnHandQuantities.userErrors || [];
    if (errs.length) return res.status(400).json({ ok: false, userErrors: errs, attempted: report });

    const changes = resp.inventorySetOnHandQuantities.inventoryAdjustmentGroup?.changes || [];
    res.json({ ok: true, fixedCount: setQuantities.length, report, changes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Global: dry (toda la tienda, no toca nada) ----
// admite ?exclude=ECI para saltar locations que contengan esa cadena
app.get('/auto-dry', async (req, res) => {
  try {
    const exclude = req.query.exclude || null;
    const pages = req.query.pages ? Number(req.query.pages) : null;
    const c = req.query.c ? Number(req.query.c) : 5;
    const raise = req.query.raise === '1';
    const corrections = await scanAllNegatives({ excludeLocationContains: exclude, maxPages: pages, concurrency: c, raise });
    res.json({
      ok: true,
      mode: 'dry-run',
      toFixCount: corrections.length,
      sample: corrections.slice(0, 50) // muestra
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Global: fix (toda la tienda, corrige) ----
app.get('/auto-fix', async (req, res) => {
  try {
    const exclude = req.query.exclude || null;
    const pages = req.query.pages ? Number(req.query.pages) : null;
    const c = req.query.c ? Number(req.query.c) : 5;
    const raise = req.query.raise === '1';
    const corrections = await scanAllNegatives({ excludeLocationContains: exclude, maxPages: pages, concurrency: c, raise });
    if (corrections.length === 0) return res.json({ ok: true, fixedCount: 0, message: 'No hay negativos que corregir 👌' });

    const results = await applyBatches(corrections, 'correction');
    res.json({
      ok: true,
      fixedCount: corrections.length,
      batches: results.length
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
