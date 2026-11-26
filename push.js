'use strict';
/**
 * Web push (no npm deps): VAPID signing (RFC 8292) + payload encryption
 * (RFC 8291, aes128gcm) using only node's built-in crypto and fetch.
 *
 * VAPID keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars win; otherwise
 * they are generated once and kept in Redis (store) or, without Redis, in a
 * local vapid.json. Subscriptions are kept per agent, in Redis when
 * configured, else pushsubs.json.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'pushsubs.json');
const MAX_SUBS_PER_AGENT = 5;

// Only the real browser push services. Tests may relax this.
const ALLOWED_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];
const allowAnyHost = () => process.env.PUSH_ALLOW_ANY_HOST === '1';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

let vapid = null; // { publicKey (b64url raw), privateKeyObj, publicKeyObj }
/** agentId -> [{ endpoint, p256dh, auth }] */
let subs = {};

async function init() {
  let pub = process.env.VAPID_PUBLIC_KEY || '';
  let priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!(pub && priv)) {
    let saved = await store.loadVapid();
    if (!saved) {
      try { saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch { /* none */ }
    }
    if (!saved || !saved.publicKey || !saved.privateKey) {
      const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = kp.privateKey.export({ format: 'jwk' });
      saved = {
        publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
        privateKey: jwk.d,
      };
      const ok = await store.persistVapid(saved);
      if (!ok) { try { fs.writeFileSync(VAPID_FILE, JSON.stringify(saved)); } catch { /* ignore */ } }
      console.log('[push] generated new VAPID keys');
    }
    pub = saved.publicKey;
    priv = saved.privateKey;
  }
  const raw = fromB64u(pub);
  const privateKeyObj = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: priv },
    format: 'jwk',
  });
  vapid = { publicKey: pub, privateKeyObj };

  let loaded = await store.loadPushSubs();
  if (!loaded) {
    try { loaded = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { loaded = {}; }
  }
  subs = loaded && typeof loaded === 'object' ? loaded : {};
}

let saveTimer = null;
function saveSubsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const ok = await store.persistPushSubs(subs);
    if (!ok) { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs)); } catch { /* ignore */ } }
  }, 500);
}

function publicKey() { return vapid ? vapid.publicKey : null; }

function validSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || !s.keys) return null;
  let u;
  try { u = new URL(s.endpoint); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowAnyHost() && u.protocol === 'http:')) return null;
  if (!allowAnyHost() && !ALLOWED_HOSTS.some((re) => re.test(u.hostname))) return null;
  if (s.endpoint.length > 1000) return null;
  const p = fromB64u(s.keys.p256dh || '');
  const a = fromB64u(s.keys.auth || '');
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return null;
  return { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
}

/** Attach a device to an agent (moving it off any other agent first). */
function addSubscription(agentId, subscription) {
  const s = validSubscription(subscription);
  if (!s) return false;
  removeEndpoint(s.endpoint, false);
  const list = subs[agentId] || (subs[agentId] = []);
  list.push(s);
  while (list.length > MAX_SUBS_PER_AGENT) list.shift();
  saveSubsSoon();
  return true;
}

function removeEndpoint(endpoint, save = true) {
  let changed = false;
  for (const id of Object.keys(subs)) {
    const before = subs[id].length;
    subs[id] = subs[id].filter((s) => s.endpoint !== endpoint);
    if (subs[id].length !== before) changed = true;
    if (!subs[id].length) delete subs[id];
  }
  if (changed && save) saveSubsSoon();
}

function hasSubscription(agentId, endpoint) {
  return (subs[agentId] || []).some((s) => s.endpoint === endpoint);
}
function agentIdsWithSubscriptions() { return Object.keys(subs); }

function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

function encrypt(sub, payloadBuf) {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prk = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([payloadBuf, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  return Buffer.concat([header, asPublic, enc]);
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: vapid.privateKeyObj, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function sendOne(sub, payload, { ttl = 60, urgency = 'high', topic } = {}) {
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidHeader(sub.endpoint),
  };
  if (topic) headers.Topic = topic;
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body: encrypt(sub, Buffer.from(JSON.stringify(payload))) });
    if (res.status === 404 || res.status === 410) { removeEndpoint(sub.endpoint); return 'gone'; }
    if (!res.ok) { console.error('[push] push service said', res.status, 'for', new URL(sub.endpoint).hostname); return 'error'; }
    return 'ok';
  } catch (err) {
    console.error('[push] send failed:', err.message);
    return 'error';
  }
}

/** Send to every device of the given agents. Returns the number of devices tried. */
async function sendToAgents(agentIds, payload, opts) {
  const targets = [];
  for (const id of agentIds) for (const s of subs[id] || []) targets.push(s);
  await Promise.all(targets.map((s) => sendOne(s, payload, opts)));
  return targets.length;
}

module.exports = {
  init, publicKey, addSubscription, removeEndpoint, hasSubscription,
  agentIdsWithSubscriptions, sendToAgents, MAX_SUBS_PER_AGENT,
  _encrypt: encrypt,
};
