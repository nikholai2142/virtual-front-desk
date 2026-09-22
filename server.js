'use strict';
/**
 * Virtual Front Desk — signaling server.
 *
 * Zero external dependencies: a hand-rolled RFC 6455 WebSocket server on top
 * of Node's built-in http module, plus a tiny static file server for
 * /public. This exists only to (a) let guest and agent browsers find each
 * other and (b) relay WebRTC signaling messages (SDP offers/answers, ICE
 * candidates) between them. The actual audio/video never touches this
 * server — it flows peer-to-peer (or via TURN) once the call is connected.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const chat = require('./chat');
const turn = require('./turn');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Agent accounts (demo auth) --------------------------------------
// Replace with real auth (SSO / PMS integration) before production use.
// Mutable (not const) because the admin dashboard can add/remove agents at
// runtime. The source of truth is Upstash Redis (see store.js) when it's
// configured — changes there survive a restart AND a fresh Render deploy.
// agents.json is only the seed for a brand-new Redis database and a local
// fallback when Redis isn't set up (e.g. running on your own machine).
const AGENTS_FILE = path.join(__dirname, 'agents.json');
function readLocalAgentsFile() {
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  } catch {
    return [
      { id: crypto.randomUUID(), name: 'Alex', password: 'alex1234' },
      { id: crypto.randomUUID(), name: 'Sam', password: 'sam5678' },
    ];
  }
}
let AGENTS = readLocalAgentsFile(); // replaced with the real Redis-backed list during startup, see main() below

/**
 * Backward-compatible migration for agent records saved before this app
 * switched from numeric-only PINs to alphanumeric passwords. Older records
 * (local agents.json from a previous deploy, or an older list already sitting
 * in Redis) look like { pin, name } with no `id`. This upgrades them in
 * place to { id, name, password } without discarding anyone's existing
 * credential, so a deploy of this change doesn't lock any agent out.
 */
function migrateAgentRecords(agents) {
  let changed = false;
  const migrated = agents.map((a) => {
    const next = { ...a };
    if (!next.id) { next.id = crypto.randomUUID(); changed = true; }
    if (next.password === undefined && next.pin !== undefined) {
      next.password = next.pin;
      changed = true;
    }
    if ('pin' in next) { delete next.pin; changed = true; }
    return next;
  });
  return { agents: migrated, changed };
}

/** Saves the current AGENTS array. Returns true only if it actually reached persistent storage. */
async function saveAgents() {
  try {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(AGENTS, null, 2));
  } catch (err) {
    // Non-fatal either way — this local file is a convenience, not the
    // source of truth, once Redis is configured.
    console.error('Could not write agents.json locally (non-fatal):', err.message);
  }
  return store.persistAgents(AGENTS);
}

// ---- Admin dashboard auth ---------------------------------------------
// One shared password, same demo-grade approach as the agent passwords —
// swap for real auth before this handles anything that matters. Set your
// own via admin.json ({ "password": "..." }) instead of editing this file,
// or change it from the dashboard itself (Settings), which updates this the
// same way the agent list is updated — local file + Redis when configured.
const ADMIN_FILE = path.join(__dirname, 'admin.json');
let ADMIN_PASSWORD = (() => {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')).password;
  } catch {
    return 'letmein';
  }
})(); // replaced with the real Redis-backed value during startup, see main() below

/** Saves the current admin password. Returns true only if it actually reached persistent storage. */
async function saveAdminPassword(password) {
  ADMIN_PASSWORD = password;
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ password }, null, 2));
  } catch (err) {
    console.error('Could not write admin.json locally (non-fatal):', err.message);
  }
  return store.persistAdminPassword(password);
}

const MAX_WAIT_WARN_MS = 60 * 1000; // client shows a "still connecting" notice
// Only applies when Redis isn't configured — call history is then purely
// in-memory (same as before), so it's capped to avoid unbounded growth.
// With Redis configured, history is persisted and effectively unlimited
// (store.js has its own much higher safety cap).
const LOCAL_ONLY_CALL_LOG_LIMIT = 200;

// ======================================================================
// Minimal WebSocket server (RFC 6455), no dependencies.
// ======================================================================

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    // The socket is upgraded from an http.Server connection, which leaves
    // it in half-open mode: when the remote side sends FIN we get 'end',
    // but the socket won't finish its own side (and so never emits
    // 'close') until we explicitly end it too. Without this, a guest
    // closing a tab or losing network never gets cleaned up server-side.
    socket.on('end', () => { this._close(); this.socket.destroy(); });
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      this._parseFrames();
    } catch (err) {
      console.error('WS frame parse error, closing this connection:', err);
      this._close();
      try { this.socket.destroy(); } catch { /* already gone */ }
    }
  }

  _parseFrames() {
    // Loop: there may be several frames queued up in the buffer.
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return;
        const hi = this.buffer.readUInt32BE(offset);
        const lo = this.buffer.readUInt32BE(offset + 4);
        payloadLen = hi * 2 ** 32 + lo;
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) return; // wait for more data

      let payload = this.buffer.subarray(offset, offset + payloadLen);
      if (masked) {
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + payloadLen);
      this._handleFrame(opcode, fin, payload);
    }
  }

  _handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) { // close
      this._sendRaw(0x8, Buffer.alloc(0));
      this.socket.end();
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      this._sendRaw(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong, ignore

    if (opcode === 0x1 || opcode === 0x2) {
      this._fragments = [payload];
      this._fragOpcode = opcode;
    } else if (opcode === 0x0) {
      if (this._fragments) this._fragments.push(payload);
    }

    if (fin && this._fragments) {
      const full = Buffer.concat(this._fragments);
      this._fragments = null;
      if (this.onMessage) {
        try {
          this.onMessage(full.toString('utf8'));
        } catch (err) {
          console.error('message handler error', err);
        }
      }
    }
  }

  _close() {
    if (!this.alive) return;
    this.alive = false;
    if (this.onClose) this.onClose();
  }

  _sendRaw(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len % 2 ** 32, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._close();
    }
  }

  send(obj) {
    this._sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this._sendRaw(0x9, Buffer.alloc(0));
  }

  close() {
    this._sendRaw(0x8, Buffer.alloc(0));
    this.socket.end();
  }
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n');
  socket.write(headers);
  return new WSConnection(socket);
}

// ======================================================================
// Static file server
// ======================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/kiosk.html';
  if (reqPath === '/agent') reqPath = '/agent.html';
  if (reqPath === '/admin') reqPath = '/admin.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ======================================================================
// Front-desk call routing state
// ======================================================================

let nextCallId = 1;
/** callId -> { topic, guestConn, agentConn, agentName, queuedAt, answeredAt, notes } */
const calls = new Map();
/** ordered array of callIds waiting for an agent */
const queue = [];
/** all connected agent sockets, for queue broadcasts */
const agentConns = new Set();
/** every live connection (guest + agent), so keepalive pings reach everyone */
const allConns = new Set();
const callLog = [];

// ---- Agent password-reset requests ------------------------------------
// An agent who forgot their password can request a reset from the login
// screen (no auth needed, obviously — that's the whole point). This queues
// a request for the admin dashboard to show and act on. In-memory only,
// same as the live call queue above: these are short-lived operational
// items, not history worth persisting across a restart (see README).
const passwordResetRequests = [];
const PASSWORD_RESET_REQUESTS_LIMIT = 200; // safety cap, not a real limit — see LOCAL_ONLY_CALL_LOG_LIMIT above

function findAgentByName(name) {
  const norm = name.trim().toLowerCase();
  return AGENTS.find((a) => a.name.trim().toLowerCase() === norm);
}

function broadcastQueue() {
  const snapshot = queue.map((callId) => {
    const c = calls.get(callId);
    return { callId, topic: c.topic, kioskId: c.kioskId, queuedAt: c.queuedAt };
  });
  for (const a of agentConns) {
    a.send({ type: 'queue-update', queue: snapshot });
  }
}

function removeFromQueue(callId) {
  const idx = queue.indexOf(callId);
  if (idx !== -1) queue.splice(idx, 1);
}

function endCall(callId, reason) {
  const call = calls.get(callId);
  if (!call) return;
  removeFromQueue(callId);
  calls.delete(callId);

  if (call.guestConn && call.guestConn.alive) {
    call.guestConn.send({ type: 'call-ended', reason });
  }
  if (call.agentConn && call.agentConn.alive) {
    call.agentConn.send({ type: 'call-ended', callId, reason });
  }

  if (call.answeredAt) {
    const entry = {
      callId,
      topic: call.topic,
      kioskId: call.kioskId,
      agentName: call.agentName || null,
      queuedAt: call.queuedAt,
      answeredAt: call.answeredAt,
      endedAt: Date.now(),
      notes: call.notes || '',
      outcome: reason,
    };
    callLog.push(entry);
    // Without Redis, history is memory-only, so keep it bounded like before.
    // With Redis, the persisted copy is the real "all-time" record; the
    // in-memory array just mirrors it for fast reads within this process.
    if (!store.configured && callLog.length > LOCAL_ONLY_CALL_LOG_LIMIT) callLog.shift();
    // Fire-and-forget: ending a call should never wait on a network round
    // trip to Redis. Failures are logged inside store.js, not thrown here.
    store.appendCallLogEntry(entry).catch(() => {});
  }
  broadcastQueue();
}

// ======================================================================
// Chat (WhatsApp / Messenger) — incoming messages arrive over the
// webhooks below; agents read/reply from the dashboard over the same
// WebSocket used for calls. This is a text-chat channel alongside video
// calls, not a replacement for them — see chat.js for the Meta API side.
// ======================================================================

/** conversationId -> { id, platform, contactId, contactName, messages: [...], lastMessageAt, unread } */
const chatConversations = new Map();
// A conversation can grow large over a long relationship with a guest —
// bounded per-conversation so memory (and the Redis value size) stay sane.
const CHAT_MESSAGES_PER_CONVO_LIMIT = 500;

function chatConversationId(platform, contactId) {
  return `${platform}:${contactId}`;
}

function getOrCreateChatConversation(platform, contactId, contactName) {
  const id = chatConversationId(platform, contactId);
  let convo = chatConversations.get(id);
  if (!convo) {
    convo = { id, platform, contactId, contactName: contactName || null, messages: [], lastMessageAt: 0, unread: false };
    chatConversations.set(id, convo);
  } else if (contactName && !convo.contactName) {
    convo.contactName = contactName;
  }
  return convo;
}

function broadcastChatUpdate(convo) {
  for (const a of agentConns) a.send({ type: 'chat-update', conversation: convo });
}

async function recordIncomingChatMessage(platform, contactId, contactName, text, at) {
  const convo = getOrCreateChatConversation(platform, contactId, contactName);
  convo.messages.push({ direction: 'in', text, at });
  if (convo.messages.length > CHAT_MESSAGES_PER_CONVO_LIMIT) convo.messages.shift();
  convo.lastMessageAt = at;
  convo.unread = true;
  broadcastChatUpdate(convo);
  store.persistChat(convo).catch(() => {});
}

// ======================================================================
// Agent self-service — request a password reset (no auth: this is exactly
// for an agent who's locked out). Intentionally unauthenticated, like the
// TURN credentials endpoint above; it only ever creates a queued request,
// never reveals or changes anything by itself.
// ======================================================================

async function handlePasswordResetRequest(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) { sendJson(res, 400, { error: 'name is required' }); return; }

  const match = findAgentByName(name);
  const entry = {
    id: crypto.randomUUID(),
    agentId: match ? match.id : null,
    name: match ? match.name : name, // keeps the on-file name if matched, else whatever they typed
    requestedAt: Date.now(),
    status: 'pending',
  };
  passwordResetRequests.unshift(entry);
  if (passwordResetRequests.length > PASSWORD_RESET_REQUESTS_LIMIT) passwordResetRequests.pop();

  console.log(`[password-reset] request received for "${name}"${match ? '' : ' (no matching agent on file)'}`);
  // Always a generic success response — this endpoint has no auth, so it
  // shouldn't confirm or deny whether "name" is a real agent.
  sendJson(res, 200, { ok: true });
}

// ======================================================================
// Admin API — manage agents and view performance.
// ======================================================================
// Auth is a single shared password sent as `X-Admin-Password` on every
// request (no sessions/cookies — this is a small internal tool, not a
// public-facing login system). Swap for real auth before this matters.

function computeAgentStats() {
  const byAgent = new Map(); // name -> { calls, totalTalkSeconds, kiosks: Map, lastCallAt }
  for (const entry of callLog) {
    const name = entry.agentName || 'Unknown';
    if (!byAgent.has(name)) {
      byAgent.set(name, { agentName: name, calls: 0, totalTalkSeconds: 0, kiosks: new Map(), lastCallAt: 0 });
    }
    const stat = byAgent.get(name);
    stat.calls += 1;
    stat.totalTalkSeconds += Math.max(0, Math.round((entry.endedAt - entry.answeredAt) / 1000));
    // Kiosk, not topic, is the interesting breakdown now that every call is
    // the same "Front Desk" topic — this shows which kiosk keeps an agent busiest.
    if (entry.kioskId) stat.kiosks.set(entry.kioskId, (stat.kiosks.get(entry.kioskId) || 0) + 1);
    stat.lastCallAt = Math.max(stat.lastCallAt, entry.endedAt);
  }
  // Include agents with zero calls too, so a brand-new agent shows up at 0 rather than being absent.
  for (const a of AGENTS) {
    if (!byAgent.has(a.name)) {
      byAgent.set(a.name, { agentName: a.name, calls: 0, totalTalkSeconds: 0, kiosks: new Map(), lastCallAt: 0 });
    }
  }
  return [...byAgent.values()]
    .map((s) => ({
      agentName: s.agentName,
      calls: s.calls,
      totalTalkSeconds: s.totalTalkSeconds,
      avgTalkSeconds: s.calls ? Math.round(s.totalTalkSeconds / s.calls) : 0,
      topKiosk: [...s.kiosks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      lastCallAt: s.lastCallAt || null,
    }))
    .sort((a, b) => b.calls - a.calls);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** Like readJsonBody, but returns the raw bytes — webhook signature
 *  verification needs the exact bytes Meta sent, not a re-serialized copy. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ======================================================================
// TURN credentials — kiosk.js and agent.js fetch this right before
// starting a call instead of using a hardcoded ICE_SERVERS array, since
// Cloudflare's TURN service issues short-lived, per-request credentials
// rather than one static secret. No auth on this endpoint: it's called by
// unauthenticated guests too, and the credentials it hands out are
// intentionally short-lived and scoped for exactly this — safe to give to
// any client. See turn.js.
// ======================================================================

async function handleTurnCredentials(req, res) {
  if (turn.configured) {
    try {
      const iceServers = await turn.generateIceServers();
      sendJson(res, 200, { iceServers, turnConfigured: true });
      return;
    } catch (err) {
      console.error('[turn] could not generate Cloudflare TURN credentials, falling back to STUN-only:', err.message);
    }
  }
  sendJson(res, 200, { iceServers: turn.STUN_ONLY_FALLBACK, turnConfigured: false });
}

// ======================================================================
// Webhooks — Meta calls these when a guest sends a WhatsApp or Messenger
// message. See chat.js for the API calls and payload parsing; this just
// wires HTTP routing + the one-time verification handshake.
// ======================================================================

function handleWebhookVerify(req, res, urlObj) {
  const query = Object.fromEntries(urlObj.searchParams);
  const challenge = chat.verifyWebhookChallenge(query);
  if (challenge !== null) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
  } else {
    res.writeHead(403).end('Forbidden');
  }
}

async function handleWhatsAppWebhookPost(req, res) {
  const raw = await readRawBody(req);
  if (!chat.verifySignature(raw, req.headers['x-hub-signature-256'])) {
    console.error('[webhook] WhatsApp: signature check failed, rejecting');
    res.writeHead(401).end('invalid signature');
    return;
  }
  // Respond quickly and unconditionally — Meta retries aggressively on a
  // slow or non-200 response, which would otherwise cause duplicate
  // deliveries of the same message.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (err) {
    console.error('[webhook] WhatsApp: could not parse payload:', err.message);
    return;
  }
  for (const msg of chat.parseWhatsAppWebhook(body)) {
    await recordIncomingChatMessage('whatsapp', msg.contactId, msg.contactName, msg.text, msg.at);
  }
}

async function handleMessengerWebhookPost(req, res) {
  const raw = await readRawBody(req);
  if (!chat.verifySignature(raw, req.headers['x-hub-signature-256'])) {
    console.error('[webhook] Messenger: signature check failed, rejecting');
    res.writeHead(401).end('invalid signature');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (err) {
    console.error('[webhook] Messenger: could not parse payload:', err.message);
    return;
  }
  for (const msg of chat.parseMessengerWebhook(body)) {
    await recordIncomingChatMessage('messenger', msg.contactId, msg.contactName, msg.text, msg.at);
  }
}

async function handleAdminApi(req, res, urlObj) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (urlObj.pathname === '/api/admin/agents' && req.method === 'GET') {
    sendJson(res, 200, { agents: AGENTS });
    return;
  }

  if (urlObj.pathname === '/api/admin/agents' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const name = String(body.name || '').trim().slice(0, 60);
    const password = String(body.password || '').trim().slice(0, 60);
    if (!name || !password) { sendJson(res, 400, { error: 'name and password are both required' }); return; }
    if (password.length < 4) { sendJson(res, 400, { error: 'password must be at least 4 characters' }); return; }
    if (AGENTS.some((a) => a.password === password)) { sendJson(res, 409, { error: 'that password is already in use' }); return; }
    AGENTS.push({ id: crypto.randomUUID(), name, password });
    const persisted = await saveAgents();
    sendJson(res, 201, { agents: AGENTS, persisted, persistenceConfigured: store.configured });
    return;
  }

  const deleteMatch = urlObj.pathname.match(/^\/api\/admin\/agents\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const before = AGENTS.length;
    AGENTS = AGENTS.filter((a) => a.id !== id);
    if (AGENTS.length === before) { sendJson(res, 404, { error: 'no agent with that id' }); return; }
    const persisted = await saveAgents();
    sendJson(res, 200, { agents: AGENTS, persisted, persistenceConfigured: store.configured });
    return;
  }

  if (urlObj.pathname === '/api/admin/change-password' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '').trim().slice(0, 60);
    if (currentPassword !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'current password is incorrect' }); return; }
    if (newPassword.length < 4) { sendJson(res, 400, { error: 'new password must be at least 4 characters' }); return; }
    const persisted = await saveAdminPassword(newPassword);
    sendJson(res, 200, { ok: true, persisted, persistenceConfigured: store.configured });
    return;
  }

  if (urlObj.pathname === '/api/admin/password-reset-requests' && req.method === 'GET') {
    sendJson(res, 200, { requests: passwordResetRequests.filter((r) => r.status === 'pending') });
    return;
  }

  const resolveResetMatch = urlObj.pathname.match(/^\/api\/admin\/password-reset-requests\/([^/]+)\/resolve$/);
  if (resolveResetMatch && req.method === 'POST') {
    const id = decodeURIComponent(resolveResetMatch[1]);
    const entry = passwordResetRequests.find((r) => r.id === id);
    if (!entry) { sendJson(res, 404, { error: 'no such request' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const newPassword = String(body.newPassword || '').trim().slice(0, 60);
    if (newPassword.length < 4) { sendJson(res, 400, { error: 'a new password of at least 4 characters is required' }); return; }
    if (!entry.agentId) {
      sendJson(res, 400, { error: 'this request has no matching agent on file — add or rename the agent first, or dismiss the request' });
      return;
    }
    const agent = AGENTS.find((a) => a.id === entry.agentId);
    if (!agent) { sendJson(res, 404, { error: 'that agent no longer exists' }); return; }
    if (AGENTS.some((a) => a.id !== agent.id && a.password === newPassword)) {
      sendJson(res, 409, { error: 'that password is already in use by another agent' });
      return;
    }
    agent.password = newPassword;
    entry.status = 'resolved';
    entry.resolvedAt = Date.now();
    const persisted = await saveAgents();
    sendJson(res, 200, { agents: AGENTS, persisted, persistenceConfigured: store.configured });
    return;
  }

  const dismissResetMatch = urlObj.pathname.match(/^\/api\/admin\/password-reset-requests\/([^/]+)$/);
  if (dismissResetMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(dismissResetMatch[1]);
    const entry = passwordResetRequests.find((r) => r.id === id);
    if (!entry) { sendJson(res, 404, { error: 'no such request' }); return; }
    entry.status = 'dismissed';
    entry.resolvedAt = Date.now();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlObj.pathname === '/api/admin/stats' && req.method === 'GET') {
    const storageStatus = store.getStatus();
    let note;
    if (!storageStatus.configured) {
      note = `Persistent storage isn't set up, so this only covers the last ${LOCAL_ONLY_CALL_LOG_LIMIT} calls and resets whenever the server restarts. See the README's "Persistent storage" section to make it permanent.`;
    } else if (storageStatus.connected) {
      note = 'Stats cover all-time call history, persisted to Redis — this survives restarts and redeploys.';
    } else {
      note = 'Persistent storage is configured but not reachable right now, so this may be missing recent history and changes might not be saved. Check the Upstash database and the server logs.';
    }
    sendJson(res, 200, {
      agents: computeAgentStats(),
      totals: {
        calls: callLog.length,
        agentsOnline: agentConns.size,
        guestsWaiting: queue.length,
        activeCalls: calls.size,
      },
      storage: storageStatus,
      note,
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function handleGuestConnection(conn) {
  let myCallId = null;
  allConns.add(conn);

  conn.onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join-queue') {
      const callId = nextCallId++;
      myCallId = callId;
      calls.set(callId, {
        topic: (msg.topic || 'General').slice(0, 60),
        kioskId: String(msg.kioskId || '').trim().slice(0, 40) || 'Unnamed kiosk',
        guestConn: conn,
        agentConn: null,
        agentName: null,
        queuedAt: Date.now(),
        answeredAt: null,
        notes: '',
      });
      queue.push(callId);
      conn.send({ type: 'queued', callId, position: queue.indexOf(callId) + 1 });
      broadcastQueue();
      return;
    }

    if (msg.type === 'signal' && myCallId) {
      const call = calls.get(myCallId);
      if (call && call.agentConn && call.agentConn.alive) {
        call.agentConn.send({ type: 'signal', callId: myCallId, signalType: msg.signalType, data: msg.data });
      }
      return;
    }

    if (msg.type === 'hangup' && myCallId) {
      endCall(myCallId, 'guest-hangup');
      myCallId = null;
      return;
    }

    if (msg.type === 'cancel-wait' && myCallId) {
      endCall(myCallId, 'guest-cancelled');
      myCallId = null;
    }
  };

  conn.onClose = () => {
    allConns.delete(conn);
    if (myCallId) endCall(myCallId, 'guest-disconnected');
  };
}

function handleAgentConnection(conn) {
  let agentName = null;
  let agentId = null;
  allConns.add(conn);
  console.log('[agent] connection handler attached, waiting for messages');

  conn.onMessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) {
      console.error('[agent] received non-JSON frame:', raw.slice(0, 200), err.message);
      return;
    }
    console.log('[agent] received message type:', msg.type);

    if (msg.type === 'agent-login') {
      const match = AGENTS.find((a) => a.password === String(msg.password || ''));
      if (!match) {
        conn.send({ type: 'agent-login-fail' });
        return;
      }
      agentName = match.name;
      agentId = match.id;
      agentConns.add(conn);
      conn.send({ type: 'agent-login-ok', name: agentName });
      broadcastQueue();
      return;
    }

    if (!agentName) return; // must log in first

    if (msg.type === 'change-password') {
      const agent = AGENTS.find((a) => a.id === agentId);
      const currentPassword = String(msg.currentPassword || '');
      const newPassword = String(msg.newPassword || '').trim().slice(0, 60);
      if (!agent || agent.password !== currentPassword) {
        conn.send({ type: 'change-password-fail', reason: 'incorrect-current-password' });
        return;
      }
      if (newPassword.length < 4) {
        conn.send({ type: 'change-password-fail', reason: 'too-short' });
        return;
      }
      if (AGENTS.some((a) => a.id !== agentId && a.password === newPassword)) {
        conn.send({ type: 'change-password-fail', reason: 'in-use' });
        return;
      }
      agent.password = newPassword;
      const persisted = await saveAgents();
      conn.send({ type: 'change-password-ok', persisted, persistenceConfigured: store.configured });
      return;
    }

    if (msg.type === 'answer-call') {
      const callId = msg.callId;
      const call = calls.get(callId);
      if (!call || !queue.includes(callId)) {
        conn.send({ type: 'answer-failed', callId, reason: 'already-taken' });
        return;
      }
      removeFromQueue(callId);
      call.agentConn = conn;
      call.agentName = agentName;
      call.answeredAt = Date.now();
      conn.send({ type: 'call-assigned', callId, topic: call.topic, kioskId: call.kioskId, queuedAt: call.queuedAt });
      if (call.guestConn && call.guestConn.alive) {
        call.guestConn.send({ type: 'call-accepted', agentName });
      }
      broadcastQueue();
      return;
    }

    if (msg.type === 'signal' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn && call.guestConn && call.guestConn.alive) {
        call.guestConn.send({ type: 'signal', signalType: msg.signalType, data: msg.data });
      }
      return;
    }

    if (msg.type === 'note' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn) call.notes = String(msg.text || '').slice(0, 2000);
      return;
    }

    if (msg.type === 'end-call' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn) endCall(msg.callId, 'agent-ended');
      return;
    }

    if (msg.type === 'get-log') {
      conn.send({ type: 'call-log', entries: callLog.slice(-50).reverse() });
      return;
    }

    if (msg.type === 'get-chats') {
      const conversations = [...chatConversations.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      conn.send({ type: 'chat-list', conversations });
      return;
    }

    if (msg.type === 'chat-mark-read' && msg.conversationId) {
      const convo = chatConversations.get(msg.conversationId);
      if (convo && convo.unread) {
        convo.unread = false;
        broadcastChatUpdate(convo);
        store.persistChat(convo).catch(() => {});
      }
      return;
    }

    if (msg.type === 'send-chat-reply' && msg.conversationId) {
      const convo = chatConversations.get(msg.conversationId);
      if (!convo) return;
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!text) return;
      try {
        if (convo.platform === 'whatsapp') await chat.sendWhatsAppMessage(convo.contactId, text);
        else if (convo.platform === 'messenger') await chat.sendMessengerMessage(convo.contactId, text);
        else throw new Error(`unknown chat platform: ${convo.platform}`);
        convo.messages.push({ direction: 'out', text, at: Date.now(), agentName });
        if (convo.messages.length > CHAT_MESSAGES_PER_CONVO_LIMIT) convo.messages.shift();
        convo.lastMessageAt = Date.now();
        convo.unread = false;
        broadcastChatUpdate(convo);
        store.persistChat(convo).catch(() => {});
      } catch (err) {
        console.error('[chat] send failed:', err.message);
        conn.send({ type: 'chat-send-failed', conversationId: convo.id, error: err.message });
      }
    }
  };

  conn.onClose = () => {
    console.log('[agent] connection closed, was logged in as:', agentName || '(never logged in)');
    allConns.delete(conn);
    agentConns.delete(conn);
    // Any call this agent was actively on gets ended so the guest isn't stuck.
    for (const [callId, call] of calls) {
      if (call.agentConn === conn) endCall(callId, 'agent-disconnected');
    }
  };
}

// ======================================================================
// HTTP server + upgrade wiring
// ======================================================================

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queue: queue.length, activeCalls: calls.size, agents: agentConns.size }));
    return;
  }
  const urlObj = new URL(req.url, 'http://x');
  if (urlObj.pathname.startsWith('/api/admin/')) {
    handleAdminApi(req, res, urlObj).catch((err) => {
      console.error('[admin api] error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/api/turn-credentials' && req.method === 'GET') {
    handleTurnCredentials(req, res).catch((err) => {
      console.error('[turn] unhandled error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/api/agent/request-password-reset' && req.method === 'POST') {
    handlePasswordResetRequest(req, res).catch((err) => {
      console.error('[password-reset] unhandled error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/webhooks/whatsapp') {
    if (req.method === 'GET') { handleWebhookVerify(req, res, urlObj); return; }
    if (req.method === 'POST') {
      handleWhatsAppWebhookPost(req, res).catch((err) => {
        console.error('[webhook] WhatsApp: unhandled error:', err);
        try { res.writeHead(500).end(); } catch { /* response already sent */ }
      });
      return;
    }
  }
  if (urlObj.pathname === '/webhooks/messenger') {
    if (req.method === 'GET') { handleWebhookVerify(req, res, urlObj); return; }
    if (req.method === 'POST') {
      handleMessengerWebhookPost(req, res).catch((err) => {
        console.error('[webhook] Messenger: unhandled error:', err);
        try { res.writeHead(500).end(); } catch { /* response already sent */ }
      });
      return;
    }
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const ip = req.socket.remoteAddress;
  console.log(`[upgrade] request for ${req.url} from ${ip}, headers:`, JSON.stringify({
    upgrade: req.headers['upgrade'],
    connection: req.headers['connection'],
    'sec-websocket-key': req.headers['sec-websocket-key'] ? '(present)' : '(MISSING)',
    'sec-websocket-version': req.headers['sec-websocket-version'],
  }));

  socket.on('error', (err) => console.error('[upgrade] raw socket error:', err.message));

  if (req.url.startsWith('/ws')) {
    const role = new URL(req.url, 'http://x').searchParams.get('role');
    const conn = acceptWebSocket(req, socket);
    if (!conn) {
      console.error(`[upgrade] rejected ${req.url} — missing Sec-WebSocket-Key`);
      return;
    }
    console.log(`[upgrade] 101 handshake sent for role=${role}`);
    if (role === 'agent') handleAgentConnection(conn);
    else handleGuestConnection(conn);
    // A proxy (Render's included) can forward bytes that arrived right after
    // the upgrade request in the same read — Node's http parser captures
    // those in `head` instead of re-emitting them as a 'data' event. Skipping
    // this meant any client that sent its first frame quickly would have
    // those bytes silently dropped, leaving the connection stuck forever.
    if (head && head.length) {
      console.log(`[upgrade] feeding ${head.length} buffered bytes from head`);
      conn._onData(head);
    }
  } else {
    console.log(`[upgrade] rejected non-/ws path: ${req.url}`);
    socket.destroy();
  }
});

// A parse error or handler bug on ONE connection should never take the
// whole server down for every other guest/agent currently on a call.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (server kept running):', err);
});

// Keepalive pings so dead connections (network drop, closed laptop lid)
// don't linger and confuse the queue — and so a proxy in front of this
// server (Render's included) doesn't treat a quiet-but-live connection as
// idle and close it out from under an in-progress call.
setInterval(() => {
  for (const c of allConns) c.ping();
}, 20000).unref();

// ======================================================================
// Startup — load agents + call history from persistent storage (if
// configured) before accepting any connections, so the very first agent
// login or admin dashboard view already sees the real, durable state.
// ======================================================================

async function main() {
  if (store.configured) {
    const connected = await store.checkConnection();
    if (connected) {
      console.log('[store] connected to Upstash Redis — agents and call history will persist across restarts and redeploys.');
    } else {
      console.log('[store] Upstash Redis is configured but not reachable right now — starting with local/in-memory data; will retry persisting on the next change.');
    }
  } else {
    console.log('[store] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — running without persistent storage (agents.json + in-memory call history only, see README).');
  }

  AGENTS = await store.loadAgents(AGENTS);
  const { agents: migratedAgents, changed: agentsMigrated } = migrateAgentRecords(AGENTS);
  AGENTS = migratedAgents;
  if (agentsMigrated) {
    console.log('[agents] upgraded stored agent record(s) from the old PIN scheme to the new id/password scheme.');
    await saveAgents();
  }
  ADMIN_PASSWORD = await store.loadAdminPassword(ADMIN_PASSWORD);
  callLog.push(...await store.loadCallLog());
  for (const c of await store.loadChats()) chatConversations.set(c.id, c);

  if (turn.configured) {
    console.log('[turn] Cloudflare TURN configured — calls will use it to connect across networks that block direct peer-to-peer.');
  } else {
    console.log('[turn] CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN not set — calls fall back to STUN-only, which cannot relay across networks that block direct connections (see README\'s "Video call relay" section).');
  }

  if (chat.whatsappConfigured || chat.messengerConfigured) {
    if (!chat.webhooksConfigured) {
      console.log('[chat] WARNING: a send channel (WhatsApp/Messenger) is configured but META_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN is missing — incoming messages will be rejected until both are set. See the README.');
    } else {
      console.log(`[chat] enabled: ${[chat.whatsappConfigured && 'WhatsApp', chat.messengerConfigured && 'Messenger'].filter(Boolean).join(' + ')}. Webhook URLs: /webhooks/whatsapp, /webhooks/messenger`);
    }
  } else {
    console.log('[chat] WhatsApp/Messenger not configured — the Chats tab in the agent dashboard will stay empty until you set it up (see README).');
  }

  server.listen(PORT, () => {
    console.log(`Virtual Front Desk listening on http://localhost:${PORT}`);
    console.log(`  Guest kiosk:    http://localhost:${PORT}/`);
    console.log(`  Agent dashboard: http://localhost:${PORT}/agent`);
    console.log(`  Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`  Loaded ${AGENTS.length} agent(s), ${callLog.length} call history entr${callLog.length === 1 ? 'y' : 'ies'}, ${chatConversations.size} chat conversation(s).`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
