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

app.get('/health', (_, res) => res.send('OK'));
app.get('/env-check', (_, res) => {
  res.json({
    SHOPIFY_SHOP: process.env.SHOPIFY_SHOP || null,
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || null,
    HAS_TOKEN: !!process.env.SHOPIFY_ADMIN_TOKEN // true/false, no mostramos el token
  });
});


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

    // calcular posibles correcciones (solo reporte)
    const corrections = [];
    for (const { node: lvl } of v.inventoryItem.inventoryLevels.edges) {
      const map = Object.fromEntries(lvl.quantities.map(q => [q.name, q.quantity]));
      const onHand = map.on_hand ?? 0;
      const available = map.available ?? 0;
      const committed = map.committed ?? 0;
      const incoming = map.incoming ?? 0;

      const shouldFix = onHand < 0 || (available < 0 && committed === 0 && incoming === 0);
      if (shouldFix) {
        corrections.push({
          inventoryItemId: v.inventoryItem.id,
          variantId: v.id,
          sku: v.sku || 'NO-SKU',
          productTitle: v.product?.title || '',
          locationId: lvl.location.id,
          locationName: lvl.location.name,
          setOnHandTo: 0,
          before: { onHand, available, committed, incoming }
        });
      }
    }

    res.json({ ok: true, mode: 'dry-run', toFixCount: corrections.length, items: corrections });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
