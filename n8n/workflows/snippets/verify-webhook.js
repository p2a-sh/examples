const crypto = require('crypto');

const PREFIX = ['wh', 'sec_'].join('');
const WINDOW_SECONDS = 300;

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const source = headers || {};
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = source[key];
    if (Array.isArray(value)) return value.map((part) => String(part)).join(',');
    return value === undefined || value === null ? '' : String(value);
  }
  return '';
}

function secretList(secrets) {
  const raw = Array.isArray(secrets) ? secrets : String(secrets || '').split(',');
  const out = [];
  for (const item of raw) {
    const text = String(item || '').trim();
    if (text) out.push(text);
  }
  return out;
}

function keyBytes(secret) {
  const text = String(secret || '');
  if (!text.startsWith(PREFIX)) return null;
  let key;
  try {
    key = Buffer.from(text.slice(PREFIX.length), 'base64');
  } catch {
    return null;
  }
  if (key.length < 24 || key.length > 64) return null;
  return key;
}

function unixSeconds(now) {
  const value = Number(now);
  if (!Number.isFinite(value)) return NaN;
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

function signatures(header) {
  return String(header || '')
    .split(/\s+/)
    .filter((part) => part.startsWith('v1,'));
}

function matches(key, id, stamp, rawBody, token) {
  const encoded = token.slice(3);
  const given = Buffer.from(encoded, 'base64');
  const expected = crypto.createHmac('sha256', key).update(id + '.' + stamp + '.' + rawBody, 'utf8').digest();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

function fail(reason) {
  return { valid: false, reason, body: null };
}

function verify({ headers, rawBody, secrets, now }) {
  const id = headerValue(headers, 'webhook-id');
  const stamp = headerValue(headers, 'webhook-timestamp');
  const signature = headerValue(headers, 'webhook-signature');
  const bodyText = typeof rawBody === 'string' ? rawBody : '';
  if (!id || !stamp || !signature) return fail('signature');
  const keys = secretList(secrets).map(keyBytes).filter(Boolean);
  const tokens = signatures(signature);
  if (!keys.length || !tokens.length) return fail('signature');
  let signed = false;
  for (const key of keys) {
    for (const token of tokens) {
      if (matches(key, id, stamp, bodyText, token)) signed = true;
    }
  }
  if (!signed) return fail('signature');
  if (!/^\d+$/.test(stamp)) return fail('timestamp');
  const nowSeconds = unixSeconds(now);
  if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - Number(stamp)) > WINDOW_SECONDS) {
    return fail('timestamp');
  }
  let body = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      body = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      body = null;
    }
  }
  return { valid: true, reason: 'ok', body };
}

function rawBodyOf(item) {
  const json = (item && item.json) || {};
  if (typeof json.rawBody === 'string') return json.rawBody;
  const binary = item && item.binary && item.binary.data && item.binary.data.data;
  if (typeof binary === 'string' && binary) return Buffer.from(binary, 'base64').toString('utf8');
  if (typeof json.body === 'string') return json.body;
  return '';
}

if (typeof $input !== 'undefined') {
  const secrets = typeof $env !== 'undefined' && $env.P2A_WEBHOOK_SECRETS ? $env.P2A_WEBHOOK_SECRETS : '';
  return $input.all().map((item, index) => ({
    json: verify({
      headers: (item.json && item.json.headers) || {},
      rawBody: rawBodyOf(item),
      secrets,
      now: Date.now(),
    }),
    pairedItem: { item: index },
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { verify, WINDOW_SECONDS };
}
