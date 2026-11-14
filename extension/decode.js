// Decode and encode (owner, Nov 14 2026: "JWT, Base64, URL decode/encode, the basic things"),
// for the Security page's testers' part. No browser APIs except crypto.subtle (the weak-secret
// check), so node --test can run it.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(text) {
  // Base64 or Base64url, with or without padding, line breaks allowed.
  let t = String(text).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('not Base64');
  t = t.replace(/=+$/, '');
  if (t.length % 4 === 1) throw new Error('not Base64 (wrong length)');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Bytes as text when they are UTF-8, else as hex. */
function bytesToText(bytes) {
  try {
    return { text: dec.decode(bytes), binary: false };
  } catch {
    return { text: toHex(bytes), binary: true };
  }
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every operation: name -> (text) -> { out, note? }. Throws with a short reason when it cannot. */
export const OPS = {
  'base64-encode': (t) => ({ out: bytesToB64(enc.encode(t)) }),
  'base64-decode': (t) => {
    const r = bytesToText(b64ToBytes(t));
    return { out: r.text, note: r.binary ? 'Not text: shown as hex' : '' };
  },
  'base64url-encode': (t) => ({ out: bytesToB64(enc.encode(t)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
  'url-encode': (t) => ({ out: encodeURIComponent(t) }),
  'url-decode': (t) => {
    try {
      return { out: decodeURIComponent(String(t).replace(/\+/g, ' ')) };
    } catch {
      throw new Error('not URL-encoded (a % without two hex digits)');
    }
  },
  'hex-encode': (t) => ({ out: toHex(enc.encode(t)) }),
  'hex-decode': (t) => {
    const h = String(t).replace(/\s+|0x|\\x|:/gi, '');
    if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error('not hex');
    const r = bytesToText(Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16)));
    return { out: r.text, note: r.binary ? 'Not text: shown as hex' : '' };
  },
  'html-encode': (t) => ({ out: String(t).replace(/[&<>"']/g, (c) => ENTITIES[c]) }),
  'html-decode': (t) => ({
    out: String(t).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k] ?? m;
    }),
  }),
  'json-pretty': (t) => {
    try {
      return { out: JSON.stringify(JSON.parse(t), null, 2) };
    } catch (e) {
      throw new Error('not JSON: ' + e.message);
    }
  },
};

/** A JWT's parts, or null when the text is not one. */
export function readJwt(token, now = Date.now()) {
  const t = String(token ?? '').trim().replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64ToBytes(parts[0])));
    payload = JSON.parse(dec.decode(b64ToBytes(parts[1])));
  } catch {
    return null;
  }
  if (typeof header !== 'object' || header === null || !('alg' in header || 'typ' in header)) return null;
  const when = (s) => (typeof s === 'number' ? new Date(s * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : null);
  const warnings = [];
  const alg = String(header.alg ?? '');
  if (!alg || alg.toLowerCase() === 'none') warnings.push('alg is "none": a server that accepts this checks no signature at all');
  if (!parts[2] && alg.toLowerCase() !== 'none') warnings.push('no signature part');
  if (typeof payload.exp !== 'number') warnings.push('no expiry (exp): the token is good forever unless the server says otherwise');
  const expired = typeof payload.exp === 'number' ? payload.exp * 1000 < now : null;
  if (header.jku || header.x5u) warnings.push('the header names where to fetch its key (jku/x5u): check the server does not follow it');
  if (header.kid && /[./\\'"]/.test(String(header.kid))) warnings.push('kid holds path or quote characters: worth testing for injection');
  return {
    header, payload, signature: parts[2], alg, expired,
    times: { issued: when(payload.iat), notBefore: when(payload.nbf), expires: when(payload.exp) },
    warnings, signed: parts[0] + '.' + parts[1],
  };
}

/** Common weak HMAC secrets: tried against an HS256/384/512 token. */
export const WEAK_SECRETS = [
  'secret', 'Secret', 'SECRET', 'password', 'Password', '123456', '12345678', 'changeme', 'changeit', 'key', 'secretkey', 'secret_key',
  'secret-key', 'jwt', 'jwtsecret', 'jwt_secret', 'jwt-secret', 'your-256-bit-secret', 'your-secret-key', 'mysecret', 'my_secret',
  'mysecretkey', 'supersecret', 'super_secret', 'topsecret', 'test', 'testing', 'admin', 'default', 'dev', 'development', 'qwerty',
  'letmein', 'shhhhh', 'shhhhhhared-secret', 'gem', 'hello', 'token', 'auth', 'api', 'apikey', 'private', 'pass', 'abc123', '1234',
  'django-insecure', 'keyboard cat', 'node', 'express', 'flask', 'laravel', 'rails', 'spring', 'app', 'application',
];

/** The secret among `secrets` that signed this HS* token, or null. Uses the browser's HMAC. */
export async function weakSecret(jwt, secrets = WEAK_SECRETS, subtle = globalThis.crypto?.subtle) {
  const hash = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' }[jwt?.alg];
  if (!hash || !subtle || !jwt.signature) return null;
  let want;
  try {
    want = toHex(b64ToBytes(jwt.signature));
  } catch {
    return null;
  }
  const data = enc.encode(jwt.signed);
  for (const s of secrets) {
    const key = await subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash }, false, ['sign']);
    const sig = new Uint8Array(await subtle.sign('HMAC', key, data));
    if (toHex(sig) === want) return s;
  }
  return null;
}
