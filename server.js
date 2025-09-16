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

function log(...args){ if (DEBUG) console.log(...args); }

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

// Devuelve { ok:boolean, mode:'ascii'|'hex'|'base64'|null, digests:{ascii,hex,base64} }
function verifyHmacAll(rawBody, signatureB64) {
  if (!WEBHOOK_SECRET || !signatureB64) return { ok:false, mode:null, digests:{} };

  const headerBuf = Buffer.from(signatureB64, 'base64');

  // 1) clave como ASCII
  const d_ascii_b64 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
  const a_ok = safeEq(Buffer.from(d_ascii_b64, 'base64'), headerBuf);

  // 2) clave como HEX (si encaja patrón de hex y longitud par)
  let h_ok = false, d_hex_b64 = null;
  if (/^[0-9a-fA-F]+$/.test(WEBHOOK_SECRET) && WEBHOOK_SECRET.length % 2 === 0) {
    const keyHex = Buffer.from(WEBHOOK_SECRET, 'hex');
    d_hex_b64 = crypto.createHmac('sha256', keyHex).update(rawBody).digest('base64');
    h_ok = safeEq(Buffer.from(d_hex_b64, 'base64'), headerBuf);
  }

  // 3) clave como BASE64 (si parece b64)
  let b_ok = false, d_b64_b64 = null;
  if (/^[A-Za-z0-9+/=]+$/.test(WEBHOOK_SECRET) && WEBHOOK_SECRET.includes('=')) {
    try {
      const keyB64 = Buffer.from(WEBHOOK_SECRET, 'base64');
      d_b64_b64 = crypto.createHmac('sha256', keyB64).update(rawBody).digest('base64');
      b_ok = safeEq(Buffer.from(d_b64_b64, 'base64'), headerBuf);
    } catch {}
  }

  const mode = a_ok ? 'ascii' : h_ok ? 'hex' : b_ok ? 'base64' : null;
  if (DEBUG) {
    console.log('➡️  HMAC signature (shopify):     ', signatureB64);
    if (d_ascii_b64) console.log('➡️  digest ascii (server):       ', d_ascii_b64, 'match?', a_ok);
    if (d_hex_b64)   console.log('➡️  digest hex   (server):       ', d_hex_b64,   'match?', h_ok);
    if (d_b64_b64)   console.log('➡️  digest base64(server):       ', d_b64_b64,   'match?', b_ok);
    console.log('➡️  MATCH MODE:', mode);
  }
  return { ok: !!mode, mode, digests: { ascii:d_ascii_b64, hex:d_hex_b64, base64:d_b64_b64 } };
}

function safeEq(a, b) {
  if (!a || !b) return false;
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

// eco crudo para verificar (sin HMAC)
app.post('/_echo_raw', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const raw = toBuf(req.body);
  console.log('ECHO RAW headers:', req.headers);
  console.log('ECHO RAW body:', raw.toString('utf8'));
  res.json({ ok: true, len: raw.length });
});

let lastPayload = null;
app.get('/_last', (_req, res) => res.json(lastPayload ?? { note: 'no payload yet' }));

function toBuf(body){ return Buffer.isBuffer(body) ? body : Buffer.from(body || ''); }

// ───────── lógica común ─────────
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
    console.error('userErrors', errs);
    return { ok: false, userErrors: errs };
  }

  return { ok: true, fixed: true, inventory_item_id: itemId, location_id: locId, set_on_hand_to: 0 };
}

// ───────── webhook real (RAW + HMAC + logs) ─────────
app.post('/webhooks/inventory_levels/update', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const raw  = toBuf(req.body);
    const sig  = (req.get('X-Shopify-Hmac-Sha256') || '').trim();
    const topic = req.get('X-Shopify-Topic');
    const shop  = req.get('X-Shopify-Shop-Domain');

    log('➡️  Webhook headers:', { topic, shop, sigLen: sig.length, contentType: req.get('content-type') });
    log('➡️  Raw length:', raw.length);

    const { ok, mode } = verifyHmacAll(raw, sig);
    if (!ok && !BYPASS) {
      console.warn('❌ Bad HMAC (rechazado).');
      return res.status(401).send('Bad HMAC');
    }
    console.log(ok ? `✅ HMAC verificado (modo ${mode}).` : '⚠️ BYPASS_HMAC activo: aceptando sin verificar.');

    // payload tolerante
    let payload = {};
    try {
      const txt = raw.toString('utf8').trim();
      payload = txt ? (JSON.parse(txt) ?? {}) : {};
    } catch (e) {
      console.warn('⚠️  JSON parse error, usando {}:', e.message);
      payload = {};
    }

    lastPayload = { at: new Date().toISOString(), headers: req.headers, payload };

    log('📦 Payload parseado:', payload);

    const result = await handleInventoryPayload(payload);
    log('🛠️  Resultado:', result);

    res.status(200).json(result);
  } catch (e) {
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
