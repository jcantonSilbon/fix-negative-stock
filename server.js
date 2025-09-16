// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP         = process.env.SHOPIFY_SHOP;
const TOKEN        = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION  = process.env.SHOPIFY_API_VERSION || '2024-04';
// soporta el typo SEGRET y trimea
const RAW_SECRET   = (process.env.SHOPIFY_WEBHOOK_SECRET ?? process.env.SHOPIFY_WEBHOOK_SEGRET ?? '').trim();
const WEBHOOK_SECRET = RAW_SECRET || null;

// ---- sanity check envs (una sola línea) ----
if (!SHOP || !TOKEN || !WEBHOOK_SECRET) console.warn('⚠️ Faltan envs: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_SECRET');

// ---- logger mínimo (método + path) ----
app.use((req, _res, next) => { 
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`); 
  next(); 
});

// ───────── helpers ─────────
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

// HMAC: si el secreto parece HEX, úsalo como hex; si no, como ascii tal cual
function verifyHmac(rawBody, signatureB64) {
  if (!WEBHOOK_SECRET || !signatureB64) return false;

  const key =
    /^[0-9a-fA-F]+$/.test(WEBHOOK_SECRET) && WEBHOOK_SECRET.length % 2 === 0
      ? Buffer.from(WEBHOOK_SECRET, 'hex')
      : WEBHOOK_SECRET; // ascii

  const calcB64 = crypto.createHmac('sha256', key).update(rawBody).digest('base64');
  const a = Buffer.from(calcB64, 'base64');
  const b = Buffer.from(signatureB64, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ───────── GQL mutation ─────────
const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

// dedupe simple (reintentos Shopify)
const seen = new Map();
const SEEN_TTL_MS = 5 * 60 * 1000;
const seenKey = (itemId, locId, available) => `${itemId}|${locId}|${available}`;
function gcSeen() { 
  const now = Date.now(); 
  for (const [k, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(k); 
}

// ───────── health/env ─────────
app.get('/health', (_req, res) => res.send('OK'));
app.get('/env-check', (_req, res) => {
  res.json({
    SHOPIFY_SHOP: SHOP || null,
    SHOPIFY_API_VERSION: API_VERSION,
    HAS_TOKEN: !!TOKEN,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
});

// ───────── lógica común ─────────
async function handleInventoryPayload(payload) {
  const itemId = payload.inventory_item_id;
  const locId  = payload.location_id;
  const avail  = Number(payload.available ?? 0);

  if (!itemId || !locId) {
    return { ok: true, ignored: 'faltan ids o body vacío' };
  }

  // dedupe por (item, loc, available)
  gcSeen();
  const key = seenKey(itemId, locId, avail);
  if (seen.has(key)) return { ok: true, deduped: true };
  seen.set(key, Date.now());

  // si no es negativo, no tocamos nada
  if (avail >= 0) return { ok: true, negative: false, available: avail };

  // NEGATIVO → fijar a 0
  const input = {
    reason: 'correction',
    setQuantities: [{
      inventoryItemId: gid('InventoryItem', itemId),
      locationId:     gid('Location', locId),
      quantity: 0
    }]
  };

  const data = await shopifyGraphQL(INVENTORY_SET_ON_HAND, { input });
  const errs = data.inventorySetOnHandQuantities.userErrors || [];
  if (errs.length) {
    console.error('❌ FIX ERROR', { itemId, locId, before: avail, errs });
    return { ok: false, userErrors: errs };
  }

  // 👇 log limpio y siempre visible cuando se corrige
  console.log(`⚡ FIXED NEGATIVE → item ${itemId} @ loc ${locId}: ${avail} → 0`);

  return {
    ok: true,
    fixed: true,
    inventory_item_id: itemId,
    location_id: locId,
    before_available: avail,
    set_on_hand_to: 0
  };
}


// ───────── webhook (RAW + HMAC) ─────────
app.post('/webhooks/inventory_levels/update', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig = (req.get('X-Shopify-Hmac-Sha256') || '').trim();

    if (!verifyHmac(raw, sig)) {
      // 401 para que Shopify reintente solo si realmente falla nuestra verificación
      return res.status(401).send('Bad HMAC');
    }

    // payload tolerante (vacío o "null")
    let payload = {};
    try {
      const txt = raw.toString('utf8').trim();
      payload = txt ? (JSON.parse(txt) ?? {}) : {};
    } catch {
      payload = {};
    }

    const result = await handleInventoryPayload(payload);
    res.status(200).json(result);
  } catch (e) {
    // 200 para no entrar en bucles de reintentos si el fallo es nuestro
    console.error('webhook error', e);
    res.status(200).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
