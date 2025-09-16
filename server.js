// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';

// Soporta el typo SEGRET y trim
const RAW_SECRET = (process.env.SHOPIFY_WEBHOOK_SECRET ?? process.env.SHOPIFY_WEBHOOK_SEGRET ?? '').trim();
const WEBHOOK_SECRET = RAW_SECRET || null;

const DEBUG  = process.env.DEBUG_WEBHOOKS === '1';
const BYPASS = process.env.BYPASS_HMAC === '1';

// ───────── logger mínimo ─────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});
const log = (...args) => { if (DEBUG) console.log(...args); };

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.warn('⚠️  Faltan envs: SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_SECRET');
}
if (DEBUG) {
  const prev = WEBHOOK_SECRET ? WEBHOOK_SECRET.slice(0,6)+'...'+WEBHOOK_SECRET.slice(-4) : null;
  console.log('🔐 Secret loaded?', !!WEBHOOK_SECRET, 'len=', WEBHOOK_SECRET?.length, 'preview=', prev);
  console.log('🧪 BYPASS_HMAC =', BYPASS);
}

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

// ───────── HMAC (simple y fiable) ─────────
function safeEq(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Prioriza ASCII (tal cual lo muestra Shopify). Si el secreto es HEX de 64 chars, también lo probamos.
function verifyHmac(rawBody, signatureB64) {
  if (!WEBHOOK_SECRET || !signatureB64) return false;

  const header = Buffer.from(signatureB64, 'base64');

  // 1) clave ASCII
  const calcAsciiB64 = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  if (safeEq(Buffer.from(calcAsciiB64, 'base64'), header)) return true;

  // 2) clave HEX (64 chars)
  if (/^[0-9a-fA-F]{64}$/.test(WEBHOOK_SECRET)) {
    const keyHex = Buffer.from(WEBHOOK_SECRET, 'hex');
    const calcHexB64 = crypto.createHmac('sha256', keyHex)
      .update(rawBody)
      .digest('base64');
    if (safeEq(Buffer.from(calcHexB64, 'base64'), header)) return true;
  }

  return false;
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

// dedupe simple
const seen = new Map();
const SEEN_TTL_MS = 5 * 60 * 1000;
const seenKey = (itemId, locId, available) => `${itemId}|${locId}|${available}`;
function gcSeen(){ const now=Date.now(); for (const [k,ts] of seen) if (now-ts>SEEN_TTL_MS) seen.delete(k); }

// ───────── endpoints básicos ─────────
app.get('/health', (_req, res) => res.send('OK'));
app.get('/env-check', (_req, res) => {
  res.json({
    SHOPIFY_SHOP: SHOP || null,
    SHOPIFY_API_VERSION: API_VERSION,
    HAS_TOKEN: !!TOKEN,
    HAS_WEBHOOK_SECRET: !!WEBHOOK_SECRET,
    BYPASS_HMAC: BYPASS
  });
});

// eco crudo para verificar (opcional)
app.post('/_echo_raw', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  log('ECHO RAW headers:', req.headers);
  log('ECHO RAW body:', raw.toString('utf8'));
  res.json({ ok: true, len: raw.length });
});

// ───────── lógica común ─────────
async function handleInventoryPayload(payload) {
  const itemId = payload.inventory_item_id;
  const locId  = payload.location_id;
  const avail  = Number(payload.available ?? 0);

  if (!itemId || !locId) return { ok: true, ignored: 'faltan ids o body vacío' };

  // dedupe por (item, loc, available)
  gcSeen();
  const key = seenKey(itemId, locId, avail);
  if (seen.has(key)) return { ok: true, deduped: true };
  seen.set(key, Date.now());

  // si no es negativo, nada que hacer
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

  // log visible siempre cuando corrige
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

    if (!verifyHmac(raw, sig) && !BYPASS) {
      console.warn('❌ Bad HMAC (rechazado).');
      return res.status(401).send('Bad HMAC');
    }
    if (DEBUG) console.log(BYPASS ? '⚠️ BYPASS_HMAC activo' : '✅ HMAC OK');

    // payload tolerante
    let payload = {};
    try {
      const txt = raw.toString('utf8').trim();
      payload = txt ? (JSON.parse(txt) ?? {}) : {};
    } catch { payload = {}; }

    const result = await handleInventoryPayload(payload);
    res.status(200).json(result);
  } catch (e) {
    // 200 para no provocar bucles si el fallo es nuestro
    console.error('webhook error', e);
    res.status(200).json({ ok: false, error: e.message });
  }
});

// ───────── test manual (sin HMAC) ─────────
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
