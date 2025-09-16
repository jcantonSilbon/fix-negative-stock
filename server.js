// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

// Lee el secreto correcto; soporta el typo por si quedó configurado así
const RAW_SECRET =
  (process.env.SHOPIFY_WEBHOOK_SECRET ?? process.env.SHOPIFY_WEBHOOK_SEGRET ?? '').trim();
const WEBHOOK_SECRET = RAW_SECRET || null;

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.warn('Faltan envs: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_SECRET');
}

// ───────────────── logger mínimo ─────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Debug controlado por env
const DEBUG = process.env.DEBUG_WEBHOOKS === '1';
function log(...args){ if (DEBUG) console.log(...args); }

// ───────────────── helpers ─────────────────
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

function verifyHmac(rawBody, req) {
  const signature = (req.get('X-Shopify-Hmac-Sha256') || '').trim();
  if (!signature || !WEBHOOK_SECRET) return false;

  // Calcula HMAC con la clave EXACTA tal como la muestra Shopify (string ASCII), no base64-decoded.
  const digestB64 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');

  // Compara buffers (base64 → bytes)
  const a = Buffer.from(digestB64, 'base64');
  const b = Buffer.from(signature,  'base64');
  if (a.length !== b.length) return false;

  const ok = crypto.timingSafeEqual(a, b);
  if (DEBUG) {
    console.log('➡️  HMAC digest (server, base64):', digestB64);
    console.log('➡️  HMAC signature (shopify):    ', signature);
    console.log('➡️  HMAC match?:', ok);
  }
  return ok;
}

// ───────────────── GQL mutation ─────────────────
const INVENTORY_SET_ON_HAND = `
  mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

// dedupe simple: Shopify reintenta webhooks
const seen = new Map();
const SEEN_TTL_MS = 5 * 60 * 1000;
const seenKey = (itemId, locId, available) => `${itemId}|${locId}|${available}`;
function gcSeen(){ const now=Date.now(); for (const [k,ts] of seen) if (now-ts>SEEN_TTL_MS) seen.delete(k); }

// ───────────────── endpoints básicos ─────────────────
app.get('/health', (_req, res) => res.send('OK'));
app.get('/env-check', (_req, res) => {
  res.json({
    SHOPIFY_SHOP: SHOP || null,
    SHOPIFY_API_VERSION: API_VERSION,
    HAS_TOKEN: !!TOKEN,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET
  });
});

// eco crudo para verificar llegada de POSTs (sin HMAC)
app.post('/_echo_raw', express.raw({ type: '*/*' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  console.log('ECHO RAW headers:', req.headers);
  console.log('ECHO RAW body:', raw.toString('utf8'));
  res.json({ ok: true, len: raw.length });
});

// ───────────────── lógica común ─────────────────
async function handleInventoryPayload(payload) {
  const itemId = payload.inventory_item_id;
  const locId  = payload.location_id;
  const avail  = Number(payload.available ?? 0);

  if (!itemId || !locId) {
    return { ok: true, ignored: 'faltan ids o body vacío' };
  }

  gcSeen();
  const key = seenKey(itemId, locId, avail);
  if (seen.has(key)) return { ok: true, deduped: true };
  seen.set(key, Date.now());

  if (avail >= 0) return { ok: true, negative: false, available: avail };

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
    return { ok: false, userErrors: errs };
  }

  return { ok: true, fixed: true, inventory_item_id: itemId, location_id: locId, set_on_hand_to: 0 };
}

// ───────────────── webhook real (RAW + HMAC + logs) ─────────────────
app.post('/webhooks/inventory_levels/update', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    const topic = req.get('X-Shopify-Topic');
    const shop  = req.get('X-Shopify-Shop-Domain');
    const sig   = req.get('X-Shopify-Hmac-Sha256') || '';

    log('➡️  Webhook headers:', { topic, shop, sigLen: sig.length, contentType: req.get('content-type') });
    log('➡️  Raw length:', raw.length);

    if (!verifyHmac(raw, req)) {
      console.warn('❌ Bad HMAC (rechazado).');
      return res.status(401).send('Bad HMAC');
    }
    console.log('✅ HMAC verificado.');

    // tolerante a cuerpo vacío o "null"
    let payload = {};
    try {
      const txt = raw.toString('utf8').trim();
      payload = txt ? (JSON.parse(txt) ?? {}) : {};
    } catch (e) {
      console.warn('⚠️  JSON parse error, usando {}:', e.message);
      payload = {};
    }

    log('📦 Payload parseado:', payload);

    const result = await handleInventoryPayload(payload);
    log('🛠️  Resultado:', result);

    res.status(200).json(result);
  } catch (e) {
    console.error('webhook error', e);
    res.status(200).json({ ok: false, error: e.message });
  }
});

// ───────────────── test manual (sin HMAC) ─────────────────
app.post('/_test/inventory_levels/update', express.json(), async (req, res) => {
  try {
    const result = await handleInventoryPayload(req.body || {});
    res.status(200).json(result);
  } catch (e) {
    console.error('test error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
