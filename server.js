// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;                // p.ej. silbon-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;         // shpat_***
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // <- OBLIGATORIO

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.warn('Faltan envs: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_SECRET');
}

// ---- body parser guardando RAW para HMAC (no cambiar el resto) ----
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ---- helpers ----
function gid(type, id) {
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
  if (!signature || !WEBHOOK_SECRET || !req.rawBody) return false;

  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false; // evita throw
  return crypto.timingSafeEqual(a, b);
}

// ---- mutation para ajustar on_hand ----
const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

// Cache anti-duplicados (Shopify puede reintentar)
const seen = new Map(); // key -> ts
const SEEN_TTL_MS = 5 * 60 * 1000;
const seenKey = (itemId, locId, available) => `${itemId}|${locId}|${available}`;
function gcSeen() {
  const now = Date.now();
  for (const [k, ts] of seen.entries()) if (now - ts > SEEN_TTL_MS) seen.delete(k);
}

// ---- endpoints mínimos ----
app.get('/health', (_req, res) => res.send('OK'));
app.get('/env-check', (_req, res) => {
  res.json({
    SHOPIFY_SHOP: SHOP || null,
    SHOPIFY_API_VERSION: API_VERSION,
    HAS_TOKEN: !!TOKEN,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
});

// Webhook: INVENTORY_LEVELS_UPDATE (topic: inventory_levels/update)
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  try {
    if (!verifyHmac(req)) return res.status(401).send('Bad HMAC');

    const payload = req.body || {};
    // Ej: { inventory_item_id, location_id, available, updated_at }
    const itemId = payload.inventory_item_id;
    const locId  = payload.location_id;
    const avail  = Number(payload.available ?? 0);

    if (!itemId || !locId) {
      return res.status(200).json({ ok: true, ignored: 'faltan ids' });
    }

    // dedupe
    gcSeen();
    const key = seenKey(itemId, locId, avail);
    if (seen.has(key)) return res.status(200).json({ ok: true, deduped: true });
    seen.set(key, Date.now());

    // sólo actuamos si es negativo
    if (avail >= 0) return res.status(200).json({ ok: true, negative: false, available: avail });

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
    return res.status(200).json({ ok: false, error: e.message });
  }
});

// (opcional) prueba local del flujo sin HMAC
app.post('/_test/inventory_levels/update', express.json(), async (req, res) => {
  req.rawBody = Buffer.from(JSON.stringify(req.body || {}));
  req.get = () => ''; // sin firma
  return app._router.handle(req, res, () => {});
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
