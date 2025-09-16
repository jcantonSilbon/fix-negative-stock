// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;                // silbon-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;         // shpat_****
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // clave de firma (DEBE estar)

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.warn('Faltan envs: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_SECRET');
}

// ------------ body parser guardando raw para HMAC ------------
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ------------ helpers ------------
function gid(type, id) {
  // type: 'InventoryItem' | 'Location'
  const s = String(id || '').trim();
  return s.startsWith('gid://') ? s : `gid://shopify/${type}/${s}`;
}

async function shopifyGraphQL(query, variables = {}) {
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

function verifyHmac(req) {
  const signature = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('base64');
  // compare in constant time
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ------------ mutation para ajustar on_hand ------------
const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

// Pequeña caché anti-duplicados (Shopify reintenta webhooks)
const seen = new Map(); // key -> ts
const SEEN_TTL_MS = 5 * 60 * 1000;

function seenKey(itemId, locId, available) {
  return `${itemId}|${locId}|${available}`;
}
function gcSeen() {
  const now = Date.now();
  for (const [k, ts] of seen.entries()) if (now - ts > SEEN_TTL_MS) seen.delete(k);
}

// ------------ endpoints mínimos ------------
app.get('/health', (_req, res) => res.send('OK'));
app.get('/env-check', (_req, res) => {
  res.json({
    SHOPIFY_SHOP: SHOP || null,
    SHOPIFY_API_VERSION: API_VERSION,
    HAS_TOKEN: !!TOKEN,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
});

// Webhook: INVENTORY_LEVELS_UPDATE
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  try {
    if (!verifyHmac(req)) {
      return res.status(401).send('Bad HMAC');
    }

    const payload = req.body || {};
    // payload típico (REST): { inventory_item_id, location_id, available, updated_at }
    const itemId = payload.inventory_item_id;
    const locId  = payload.location_id;
    const avail  = Number(payload.available ?? 0);

    if (!itemId || !locId) {
      return res.status(200).json({ ok: true, ignored: 'faltan ids' }); // responder 200 para que no reintente
    }

    // dedupe por (item, loc, available)
    gcSeen();
    const key = seenKey(itemId, locId, avail);
    if (seen.has(key)) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    seen.set(key, Date.now());

    // Sólo actuamos si el available es negativo
    if (avail >= 0) {
      return res.status(200).json({ ok: true, negative: false, available: avail });
    }

    const input = {
      reason: 'auto-fix-negative-available',
      setQuantities: [{
        inventoryItemId: gid('InventoryItem', itemId),
        locationId:     gid('Location', locId),
        quantity: 0
      }]
    };

    const data = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
    const errs = data.inventorySetOnHandQuantities.userErrors || [];
    if (errs.length) {
      console.error('userErrors', errs);
      // devolvemos 200 igualmente para que Shopify no reintente indefinidamente,
      // pero dejamos constancia del error
      return res.status(200).json({ ok: false, userErrors: errs });
    }

    return res.status(200).json({
      ok: true,
      fixed: true,
      inventory_item_id: itemId,
      location_id: locId,
      set_on_hand_to: 0
    });
  } catch (e) {
    console.error('webhook error', e);
    // 200 para evitar bucles de reintentos si el fallo es nuestro
    return res.status(200).json({ ok: false, error: e.message });
  }
});

// (Opcional) endpoint para probar manualmente el flujo sin Shopify
app.post('/_test/inventory_levels/update', express.json(), async (req, res) => {
  req.rawBody = Buffer.from(JSON.stringify(req.body || {}));
  req.get = () => ''; // sin firma
  return app._router.handle(req, res, () => {});
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
