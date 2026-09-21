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

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Agent accounts (demo auth) --------------------------------------
// Replace with real auth (SSO / PMS integration) before production use.
const AGENTS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'agents.json'), 'utf8'));
  } catch {
    return [
      { pin: '1234', name: 'Alex' },
      { pin: '5678', name: 'Sam' },
    ];
  }
})();

const MAX_WAIT_WARN_MS = 60 * 1000; // client shows a "still connecting" notice
const CALL_LOG_LIMIT = 200;

// ======================================================================
// Minimal WebSocket server (RFC 6455), no dependencies.
// ======================================================================

const WS_MAGIC = '258EAFA35E-4E45-9E82-C4C4F53F87BA';

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
const callLog = [];

function broadcastQueue() {
  const snapshot = queue.map((callId) => {
    const c = calls.get(callId);
    return { callId, topic: c.topic, queuedAt: c.queuedAt };
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
    callLog.push({
      callId,
      topic: call.topic,
      agentName: call.agentName || null,
      queuedAt: call.queuedAt,
      answeredAt: call.answeredAt,
      endedAt: Date.now(),
      notes: call.notes || '',
      outcome: reason,
    });
    if (callLog.length > CALL_LOG_LIMIT) callLog.shift();
  }
  broadcastQueue();
}

function handleGuestConnection(conn) {
  let myCallId = null;

  conn.onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join-queue') {
      const callId = nextCallId++;
      myCallId = callId;
      calls.set(callId, {
        topic: (msg.topic || 'General').slice(0, 60),
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
    if (myCallId) endCall(myCallId, 'guest-disconnected');
  };
}

function handleAgentConnection(conn) {
  let agentName = null;

  conn.onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'agent-login') {
      const match = AGENTS.find((a) => a.pin === String(msg.pin || ''));
      if (!match) {
        conn.send({ type: 'agent-login-fail' });
        return;
      }
      agentName = match.name;
      agentConns.add(conn);
      conn.send({ type: 'agent-login-ok', name: agentName });
      broadcastQueue();
      return;
    }

    if (!agentName) return; // must log in first

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
      conn.send({ type: 'call-assigned', callId, topic: call.topic, queuedAt: call.queuedAt });
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
    }
  };

  conn.onClose = () => {
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
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    const role = new URL(req.url, 'http://x').searchParams.get('role');
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    if (role === 'agent') handleAgentConnection(conn);
    else handleGuestConnection(conn);
    // A proxy (Render's included) can forward bytes that arrived right after
    // the upgrade request in the same read — Node's http parser captures
    // those in `head` instead of re-emitting them as a 'data' event. Skipping
    // this meant any client that sent its first frame quickly would have
    // those bytes silently dropped, leaving the connection stuck forever.
    if (head && head.length) conn._onData(head);
  } else {
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
// don't linger and confuse the queue.
setInterval(() => {
  for (const a of agentConns) a.ping();
}, 25000).unref();

server.listen(PORT, () => {
  console.log(`Virtual Front Desk listening on http://localhost:${PORT}`);
  console.log(`  Guest kiosk:    http://localhost:${PORT}/`);
  console.log(`  Agent dashboard: http://localhost:${PORT}/agent`);
});
