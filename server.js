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
const r2 = require('./r2');

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
    // Agents created before multi-language support default to the base
    // language — this runs at startup (see main()), so an agent who could
    // take every call before this feature existed still can afterward,
    // rather than silently going quiet because nothing is tagged.
    if (!Array.isArray(next.languages) || !next.languages.length) {
      next.languages = [DEFAULT_LANGUAGE];
      changed = true;
    }
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

// ---- Kiosk accounts (demo auth) --------------------------------------
// Each physical kiosk device signs in with one of these (name + password)
// instead of just picking a free-text label the way it used to — see
// kioskSessions below for the single-active-session enforcement this
// enables. Same seed/fallback/Redis pattern as AGENTS above.
const KIOSKS_FILE = path.join(__dirname, 'kiosks.json');
function readLocalKiosksFile() {
  try {
    return JSON.parse(fs.readFileSync(KIOSKS_FILE, 'utf8'));
  } catch {
    return [{ id: crypto.randomUUID(), name: 'Lobby', password: 'lobby1234' }];
  }
}
let KIOSKS = readLocalKiosksFile(); // replaced with the real Redis-backed list during startup, see main() below

/** Saves the current KIOSKS array. Returns true only if it actually reached persistent storage. */
async function saveKiosks() {
  try {
    fs.writeFileSync(KIOSKS_FILE, JSON.stringify(KIOSKS, null, 2));
  } catch (err) {
    console.error('Could not write kiosks.json locally (non-fatal):', err.message);
  }
  return store.persistKiosks(KIOSKS);
}

// ---- Per-kiosk branding (logo, background photo, accent color) ---------
// Each kiosk account can optionally override the global kiosk.css look —
// see the admin dashboard's Kiosk Accounts panel. Uploaded images are
// stored on local disk under public/, so the existing static file server
// (serveStatic, below) serves them with no extra routing needed — the
// same way the global public/branding/ assets already are.
const KIOSK_BRANDING_DIR = path.join(PUBLIC_DIR, 'branding', 'kiosks');
const MAX_BRANDING_UPLOAD_BYTES = 8 * 1024 * 1024; // JSON body cap — covers base64 overhead on a ~5MB image
const MAX_BRANDING_IMAGE_BYTES = 5 * 1024 * 1024; // decoded image size cap, per file
const BRANDING_IMAGE_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/** Decodes a `data:image/...;base64,...` string, validating its type and size. Throws with a message safe to show the admin. */
function decodeBrandingImage(dataUrl, { allowSvg }) {
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('That doesn\'t look like an image file.');
  const mime = match[1].toLowerCase();
  const ext = BRANDING_IMAGE_EXT_BY_MIME[mime];
  if (!ext || (mime === 'image/svg+xml' && !allowSvg)) {
    throw new Error(allowSvg ? 'Use a PNG, JPEG, WEBP, or SVG image.' : 'Use a PNG, JPEG, or WEBP image.');
  }
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_BRANDING_IMAGE_BYTES) throw new Error('Image is too large (max 5MB).');
  return { buf, ext };
}

/** Deletes any existing `<baseName>.*` file in `dir` — run before writing a
 *  fresh upload so re-uploading in a different format (e.g. png → jpg)
 *  doesn't leave the old file behind, still being served alongside it. */
function clearBrandingFile(dir, baseName) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(`${baseName}.`)) {
      try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
    }
  }
}

// ---- Languages -----------------------------------------------------------
// WORLD_LANGUAGES is the full ISO 639-1 catalog (~180 languages) — every
// language the admin dashboard *could* turn on, not what any one property
// actually uses. Which subset is actually offered for tagging agents and
// picked by guests is admin-editable at runtime (CONFIG.enabledLanguages,
// managed from Configuration > Languages, POST /api/admin/languages) rather
// than a fixed list baked into this file, so growing or shrinking the active
// set no longer needs a code change or redeploy.
const WORLD_LANGUAGES = [
  { code: 'aa', label: 'Afar' }, { code: 'ab', label: 'Abkhazian' }, { code: 'af', label: 'Afrikaans' },
  { code: 'ak', label: 'Akan' }, { code: 'am', label: 'Amharic' }, { code: 'an', label: 'Aragonese' },
  { code: 'ar', label: 'Arabic' }, { code: 'as', label: 'Assamese' }, { code: 'av', label: 'Avaric' },
  { code: 'ay', label: 'Aymara' }, { code: 'az', label: 'Azerbaijani' }, { code: 'ba', label: 'Bashkir' },
  { code: 'be', label: 'Belarusian' }, { code: 'bg', label: 'Bulgarian' }, { code: 'bh', label: 'Bihari' },
  { code: 'bi', label: 'Bislama' }, { code: 'bm', label: 'Bambara' }, { code: 'bn', label: 'Bengali' },
  { code: 'bo', label: 'Tibetan' }, { code: 'br', label: 'Breton' }, { code: 'bs', label: 'Bosnian' },
  { code: 'ca', label: 'Catalan' }, { code: 'ce', label: 'Chechen' }, { code: 'ch', label: 'Chamorro' },
  { code: 'co', label: 'Corsican' }, { code: 'cr', label: 'Cree' }, { code: 'cs', label: 'Czech' },
  { code: 'cu', label: 'Church Slavic' }, { code: 'cv', label: 'Chuvash' }, { code: 'cy', label: 'Welsh' },
  { code: 'da', label: 'Danish' }, { code: 'de', label: 'German' }, { code: 'dv', label: 'Divehi' },
  { code: 'dz', label: 'Dzongkha' }, { code: 'ee', label: 'Ewe' }, { code: 'el', label: 'Greek' },
  { code: 'en', label: 'English' }, { code: 'eo', label: 'Esperanto' }, { code: 'es', label: 'Spanish' },
  { code: 'et', label: 'Estonian' }, { code: 'eu', label: 'Basque' }, { code: 'fa', label: 'Persian' },
  { code: 'ff', label: 'Fulah' }, { code: 'fi', label: 'Finnish' }, { code: 'fj', label: 'Fijian' },
  { code: 'fo', label: 'Faroese' }, { code: 'fr', label: 'French' }, { code: 'fy', label: 'Western Frisian' },
  { code: 'ga', label: 'Irish' }, { code: 'gd', label: 'Scottish Gaelic' }, { code: 'gl', label: 'Galician' },
  { code: 'gn', label: 'Guarani' }, { code: 'gu', label: 'Gujarati' }, { code: 'gv', label: 'Manx' },
  { code: 'ha', label: 'Hausa' }, { code: 'he', label: 'Hebrew' }, { code: 'hi', label: 'Hindi' },
  { code: 'ho', label: 'Hiri Motu' }, { code: 'hr', label: 'Croatian' }, { code: 'ht', label: 'Haitian Creole' },
  { code: 'hu', label: 'Hungarian' }, { code: 'hy', label: 'Armenian' }, { code: 'hz', label: 'Herero' },
  { code: 'ia', label: 'Interlingua' }, { code: 'id', label: 'Indonesian' }, { code: 'ie', label: 'Interlingue' },
  { code: 'ig', label: 'Igbo' }, { code: 'ii', label: 'Sichuan Yi' }, { code: 'ik', label: 'Inupiaq' },
  { code: 'io', label: 'Ido' }, { code: 'is', label: 'Icelandic' }, { code: 'it', label: 'Italian' },
  { code: 'iu', label: 'Inuktitut' }, { code: 'ja', label: 'Japanese' }, { code: 'jv', label: 'Javanese' },
  { code: 'ka', label: 'Georgian' }, { code: 'kg', label: 'Kongo' }, { code: 'ki', label: 'Kikuyu' },
  { code: 'kj', label: 'Kuanyama' }, { code: 'kk', label: 'Kazakh' }, { code: 'kl', label: 'Kalaallisut' },
  { code: 'km', label: 'Khmer' }, { code: 'kn', label: 'Kannada' }, { code: 'ko', label: 'Korean' },
  { code: 'kr', label: 'Kanuri' }, { code: 'ks', label: 'Kashmiri' }, { code: 'ku', label: 'Kurdish' },
  { code: 'kv', label: 'Komi' }, { code: 'kw', label: 'Cornish' }, { code: 'ky', label: 'Kyrgyz' },
  { code: 'la', label: 'Latin' }, { code: 'lb', label: 'Luxembourgish' }, { code: 'lg', label: 'Ganda' },
  { code: 'li', label: 'Limburgish' }, { code: 'ln', label: 'Lingala' }, { code: 'lo', label: 'Lao' },
  { code: 'lt', label: 'Lithuanian' }, { code: 'lu', label: 'Luba-Katanga' }, { code: 'lv', label: 'Latvian' },
  { code: 'mg', label: 'Malagasy' }, { code: 'mh', label: 'Marshallese' }, { code: 'mi', label: 'Maori' },
  { code: 'mk', label: 'Macedonian' }, { code: 'ml', label: 'Malayalam' }, { code: 'mn', label: 'Mongolian' },
  { code: 'mr', label: 'Marathi' }, { code: 'ms', label: 'Malay' }, { code: 'mt', label: 'Maltese' },
  { code: 'my', label: 'Burmese' }, { code: 'na', label: 'Nauru' }, { code: 'nb', label: 'Norwegian Bokmål' },
  { code: 'nd', label: 'North Ndebele' }, { code: 'ne', label: 'Nepali' }, { code: 'ng', label: 'Ndonga' },
  { code: 'nl', label: 'Dutch' }, { code: 'nn', label: 'Norwegian Nynorsk' }, { code: 'no', label: 'Norwegian' },
  { code: 'nr', label: 'South Ndebele' }, { code: 'nv', label: 'Navajo' }, { code: 'ny', label: 'Chichewa' },
  { code: 'oc', label: 'Occitan' }, { code: 'oj', label: 'Ojibwe' }, { code: 'om', label: 'Oromo' },
  { code: 'or', label: 'Odia' }, { code: 'os', label: 'Ossetian' }, { code: 'pa', label: 'Punjabi' },
  { code: 'pi', label: 'Pali' }, { code: 'pl', label: 'Polish' }, { code: 'ps', label: 'Pashto' },
  { code: 'pt', label: 'Portuguese' }, { code: 'qu', label: 'Quechua' }, { code: 'rm', label: 'Romansh' },
  { code: 'rn', label: 'Kirundi' }, { code: 'ro', label: 'Romanian' }, { code: 'ru', label: 'Russian' },
  { code: 'rw', label: 'Kinyarwanda' }, { code: 'sa', label: 'Sanskrit' }, { code: 'sc', label: 'Sardinian' },
  { code: 'sd', label: 'Sindhi' }, { code: 'se', label: 'Northern Sami' }, { code: 'sg', label: 'Sango' },
  { code: 'si', label: 'Sinhala' }, { code: 'sk', label: 'Slovak' }, { code: 'sl', label: 'Slovenian' },
  { code: 'sm', label: 'Samoan' }, { code: 'sn', label: 'Shona' }, { code: 'so', label: 'Somali' },
  { code: 'sq', label: 'Albanian' }, { code: 'sr', label: 'Serbian' }, { code: 'ss', label: 'Swati' },
  { code: 'st', label: 'Southern Sotho' }, { code: 'su', label: 'Sundanese' }, { code: 'sv', label: 'Swedish' },
  { code: 'sw', label: 'Swahili' }, { code: 'ta', label: 'Tamil' }, { code: 'te', label: 'Telugu' },
  { code: 'tg', label: 'Tajik' }, { code: 'th', label: 'Thai' }, { code: 'ti', label: 'Tigrinya' },
  { code: 'tk', label: 'Turkmen' }, { code: 'tl', label: 'Tagalog' }, { code: 'tn', label: 'Tswana' },
  { code: 'to', label: 'Tongan' }, { code: 'tr', label: 'Turkish' }, { code: 'ts', label: 'Tsonga' },
  { code: 'tt', label: 'Tatar' }, { code: 'tw', label: 'Twi' }, { code: 'ty', label: 'Tahitian' },
  { code: 'ug', label: 'Uyghur' }, { code: 'uk', label: 'Ukrainian' }, { code: 'ur', label: 'Urdu' },
  { code: 'uz', label: 'Uzbek' }, { code: 've', label: 'Venda' }, { code: 'vi', label: 'Vietnamese' },
  { code: 'vo', label: 'Volapük' }, { code: 'wa', label: 'Walloon' }, { code: 'wo', label: 'Wolof' },
  { code: 'xh', label: 'Xhosa' }, { code: 'yi', label: 'Yiddish' }, { code: 'yo', label: 'Yoruba' },
  { code: 'za', label: 'Zhuang' }, { code: 'zh', label: 'Chinese (Mandarin)' }, { code: 'zu', label: 'Zulu' },
];
const WORLD_LANGUAGE_CODES = new Set(WORLD_LANGUAGES.map((l) => l.code));
const WORLD_LANGUAGE_LABEL = new Map(WORLD_LANGUAGES.map((l) => [l.code, l.label]));
const DEFAULT_LANGUAGE = 'en';
// What a brand-new install starts out with enabled — the same 12 this
// project shipped with before the world catalog existed. Just a starting
// point: the admin can enable/disable anything from here on (see
// CONFIG.enabledLanguages, below, and the Configuration > Languages panel).
const DEFAULT_ENABLED_LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ar', 'pt', 'ru', 'it', 'hi'];

/** The set of language codes an admin currently has switched on — always includes the default, so the picker/tagging UI can never end up with zero usable options. */
function enabledLanguageCodes() {
  const stored = Array.isArray(CONFIG.enabledLanguages) ? CONFIG.enabledLanguages : DEFAULT_ENABLED_LANGUAGES;
  const codes = new Set(stored.filter((c) => WORLD_LANGUAGE_CODES.has(c)));
  codes.add(DEFAULT_LANGUAGE);
  return codes;
}
/** {code,label} entries for just the currently-enabled languages, in WORLD_LANGUAGES order. This is what kiosk.js/agent.js/admin.js's agent-tagging UI see as "the" language list. */
function supportedLanguages() {
  const codes = enabledLanguageCodes();
  return WORLD_LANGUAGES.filter((l) => codes.has(l.code));
}
function languageLabel(code) {
  return WORLD_LANGUAGE_LABEL.get(code) || code;
}
/** Filters+dedupes a client-supplied language list down to only currently-enabled codes. */
function normalizeLanguages(input) {
  if (!Array.isArray(input)) return [];
  const codes = enabledLanguageCodes();
  return [...new Set(input.filter((c) => codes.has(c)))];
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

// ---- App config (video call configuration) -----------------------------
// Currently just the max hold duration, but this is the one place to add
// more admin-tunable video-call settings later. Same seed/fallback pattern
// as the admin password: a local config.json is the seed for a brand-new
// Redis database and the fallback when Redis isn't configured.
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = { maxHoldSeconds: 300, enabledLanguages: DEFAULT_ENABLED_LANGUAGES, logoSizePx: 72 }; // 5 minutes hold, 72px logo (the original hardcoded kiosk.css value)
const MIN_HOLD_SECONDS = 10;
const MAX_HOLD_SECONDS = 3600; // 1 hour — generous ceiling, not a recommendation
const MIN_LOGO_SIZE_PX = 24;
const MAX_LOGO_SIZE_PX = 320;
function readLocalConfigFile() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
let CONFIG = readLocalConfigFile(); // replaced with the real Redis-backed value during startup, see main() below

/** Saves the current app config. Returns true only if it actually reached persistent storage. */
async function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
  } catch (err) {
    console.error('Could not write config.json locally (non-fatal):', err.message);
  }
  return store.persistConfig(CONFIG);
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
    // Heartbeat bookkeeping for the keepalive interval below (separate from
    // `alive`, which just means "hasn't been torn down yet"). Starts true so
    // a brand-new connection isn't terminated before its first ping cycle.
    // See the interval's own comment for why this exists at all.
    this.heartbeatOk = true;
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
    if (opcode === 0xa) { // pong — proof this connection is still actually alive, see the keepalive interval below
      this.heartbeatOk = true;
      return;
    }

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

  /**
   * Forcibly tears down a connection the keepalive interval has decided is
   * dead (missed a pong). Unlike close(), this doesn't bother with a
   * graceful close-frame handshake — a connection that isn't answering pings
   * isn't going to answer that either — it just runs the same cleanup a
   * real socket 'close'/'error' would (via _close(), which fires onClose())
   * and drops the underlying TCP socket immediately.
   */
  terminate() {
    this._close();
    try { this.socket.destroy(); } catch { /* already gone */ }
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
  // .jpg/.jpeg/.webp: added for the kiosk's branding/background.* image —
  // see public/kiosk.css and the README's "Customizing the kiosk's
  // branding" section. Without a matching Content-Type here, a browser
  // won't reliably treat the file as a usable CSS background image.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
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
/**
 * callId -> {
 *   topic, kioskId, language, guestConn, agentConn, agentId, agentName,
 *   queuedAt, answeredAt, notes,
 *   onHold, holdStartedAt, holdSecondsTotal, holdCount, holdWarnTimer, holdExpireTimer,
 *   transferredFrom, transferNote, transferCount,
 * }
 * The hold fields track HOLD (see "Call hold" section below): whether the
 * call is on hold right now, when the current hold began, accumulated hold
 * seconds across every hold during this call (added to holdSecondsTotal
 * each time a hold ends), how many times it's been put on hold, and the
 * two scheduled timers (30s warning + auto-resume) for the hold in progress.
 *
 * The transfer fields (see "Call transfer" section below) carry context
 * from the last transfer, if any: which agent handed the call off, the
 * note they left, and how many times this call has been transferred in
 * total. `language` is the guest's picked language — normally fixed for
 * the life of the call, but a transfer can change it (e.g. the answering
 * agent realizes the guest actually needs a different language than they
 * initially picked).
 */
const calls = new Map();
/** ordered array of callIds waiting for an agent */
const queue = [];
/** all connected agent sockets, for queue broadcasts */
const agentConns = new Set();
/** every live connection (guest + agent), so keepalive pings reach everyone */
const allConns = new Set();
// Which connection currently "owns" each kiosk account's session — keyed by
// kiosk id, one entry per kiosk at most. This is what makes a kiosk login
// exclusive: a second login attempt for a kiosk already in here is rejected
// (see handleGuestConnection's 'kiosk-login' handling) rather than allowed
// to sign in alongside the first, the way agents can today. Entries are
// removed the moment that connection closes (clean sign-out, tab closed, or
// the heartbeat below finally notices a dead connection) — never on a timer
// — so a kiosk that's actually offline doesn't stay "signed in" for long.
const kioskSessions = new Map();

const callLog = [];
/**
 * Calls that were never answered — the guest gave up waiting or lost their
 * connection before an agent picked up. Kept separate from callLog (not
 * merged in with a null agent/answeredAt) because callLog's stats math
 * (statsForEntries, entriesForAgent, computeAgentStats, and the dashboard's
 * date-range filter) all assume every entry has a real answeredAt — mixing
 * in unanswered calls would corrupt those averages rather than just adding
 * a zero.
 */
const missedCallLog = [];

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

/** The agent record for a logged-in agent connection (conn.agentId is set at login — see handleAgentConnection). */
function agentRecordFor(conn) {
  return AGENTS.find((a) => a.id === conn.agentId);
}

/** An agent's language tags, defaulting to the base language for a record that somehow has none (shouldn't happen post-migration, but keeps this safe). */
function agentLanguages(conn) {
  const agent = agentRecordFor(conn);
  return (agent && Array.isArray(agent.languages) && agent.languages.length) ? agent.languages : [DEFAULT_LANGUAGE];
}

/**
 * Whether `call` should be shown to (and answerable by) the agent on `conn`.
 * Normally that's just a language match. But if NOT ONE currently-connected
 * agent speaks the call's language, it's shown to everyone instead — a
 * guest should never be stranded in the queue forever just because nobody
 * on shift happens to be tagged for the language they picked.
 */
function queueVisibleTo(call, conn) {
  if (agentLanguages(conn).includes(call.language)) return true;
  return ![...agentConns].some((a) => agentLanguages(a).includes(call.language));
}

function broadcastQueue() {
  for (const a of agentConns) {
    const snapshot = queue
      .map((callId) => ({ callId, c: calls.get(callId) }))
      .filter(({ c }) => c && queueVisibleTo(c, a))
      .map(({ callId, c }) => ({
        callId,
        topic: c.topic,
        kioskId: c.kioskId,
        queuedAt: c.queuedAt,
        language: c.language,
        languageLabel: languageLabel(c.language),
        transferredFrom: c.transferredFrom || null,
        transferNote: c.transferNote || null,
      }));
    a.send({ type: 'queue-update', queue: snapshot });
  }
}

function removeFromQueue(callId) {
  const idx = queue.indexOf(callId);
  if (idx !== -1) queue.splice(idx, 1);
}

// ======================================================================
// Call hold — an agent can put an active call on hold; the guest and agent
// both see an on-hold state (no live audio/video from the agent's side —
// see agent.js, which mutes its own tracks rather than renegotiating the
// peer connection). The hold has a maximum duration set by the admin
// (CONFIG.maxHoldSeconds): the agent gets a warning 30 seconds before it
// expires, and if nobody resumes it manually by then, the call resumes on
// its own so a guest can never be left on hold indefinitely by mistake.
// ======================================================================

function clearHoldTimers(call) {
  if (call.holdWarnTimer) { clearTimeout(call.holdWarnTimer); call.holdWarnTimer = null; }
  if (call.holdExpireTimer) { clearTimeout(call.holdExpireTimer); call.holdExpireTimer = null; }
}

/** Folds the current hold's elapsed time into the call's running total. Safe to call even if not on hold. */
function accumulateHoldTime(call) {
  if (!call.onHold || !call.holdStartedAt) return;
  call.holdSecondsTotal = (call.holdSecondsTotal || 0) + Math.max(0, Math.round((Date.now() - call.holdStartedAt) / 1000));
  call.holdStartedAt = null;
}

function beginHold(callId) {
  const call = calls.get(callId);
  if (!call || call.onHold) return;
  clearHoldTimers(call);
  call.onHold = true;
  call.holdStartedAt = Date.now();
  call.holdCount = (call.holdCount || 0) + 1;
  const maxHoldSeconds = CONFIG.maxHoldSeconds;

  // call-hold has to reach the agent BEFORE any hold-expiring-soon — the
  // client only acts on the warning once it already thinks it's on hold, so
  // sending them in the other order (possible below, when the configured
  // limit is short enough to warn immediately) would leave that first
  // warning silently ignored.
  const payload = { type: 'call-hold', callId, maxHoldSeconds, holdStartedAt: call.holdStartedAt };
  if (call.agentConn && call.agentConn.alive) call.agentConn.send(payload);
  if (call.guestConn && call.guestConn.alive) call.guestConn.send(payload);

  if (maxHoldSeconds > 30) {
    call.holdWarnTimer = setTimeout(() => {
      if (call.agentConn && call.agentConn.alive) {
        call.agentConn.send({ type: 'hold-expiring-soon', callId, secondsLeft: 30 });
      }
    }, (maxHoldSeconds - 30) * 1000);
  } else {
    // Too short a limit for a separate 30s-out warning — just warn immediately.
    if (call.agentConn && call.agentConn.alive) {
      call.agentConn.send({ type: 'hold-expiring-soon', callId, secondsLeft: maxHoldSeconds });
    }
  }
  call.holdExpireTimer = setTimeout(() => resumeHold(callId, 'timeout'), maxHoldSeconds * 1000);
}

function resumeHold(callId, reason) {
  const call = calls.get(callId);
  if (!call || !call.onHold) return;
  clearHoldTimers(call);
  accumulateHoldTime(call);
  call.onHold = false;

  const payload = { type: 'call-resumed', callId, reason };
  if (call.agentConn && call.agentConn.alive) call.agentConn.send(payload);
  if (call.guestConn && call.guestConn.alive) call.guestConn.send(payload);
}

function endCall(callId, reason) {
  const call = calls.get(callId);
  if (!call) return;
  clearHoldTimers(call);
  accumulateHoldTime(call); // in case the call ends while still on hold
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
      language: call.language,
      agentId: call.agentId || null,
      agentName: call.agentName || null,
      queuedAt: call.queuedAt,
      answeredAt: call.answeredAt,
      endedAt: Date.now(),
      notes: call.notes || '',
      outcome: reason,
      holdSeconds: call.holdSecondsTotal || 0,
      holdCount: call.holdCount || 0,
      transferredFrom: call.transferredFrom || null,
    };
    callLog.push(entry);
    // Without Redis, history is memory-only, so keep it bounded like before.
    // With Redis, the persisted copy is the real "all-time" record; the
    // in-memory array just mirrors it for fast reads within this process.
    if (!store.configured && callLog.length > LOCAL_ONLY_CALL_LOG_LIMIT) callLog.shift();
    // Fire-and-forget: ending a call should never wait on a network round
    // trip to Redis. Failures are logged inside store.js, not thrown here.
    store.appendCallLogEntry(entry).catch(() => {});

    // The "Recent calls" list on every agent's dashboard is a shared,
    // all-agent view (the server hands back callLog as a whole, not
    // filtered to just that agent), so every signed-in agent needs to know
    // it just changed — not only whichever agent happened to be on this
    // particular call (that agent already gets their own 'call-ended'
    // above, for their active-call UI). Without this, any other agent's
    // list would silently go stale until they happened to refresh the page.
    for (const a of agentConns) {
      a.send({ type: 'call-log-changed' });
    }
  } else {
    // Never answered — the guest gave up waiting ('guest-cancelled') or
    // lost their connection before an agent could pick up
    // ('guest-disconnected'). Tracked separately from callLog (see
    // missedCallLog above) so the admin dashboard's "not answered" count
    // reflects it without mixing an agent-less entry into the answered-call
    // stats math.
    const entry = {
      callId,
      topic: call.topic,
      kioskId: call.kioskId,
      language: call.language,
      queuedAt: call.queuedAt,
      endedAt: Date.now(),
      outcome: reason,
    };
    missedCallLog.push(entry);
    if (!store.configured && missedCallLog.length > LOCAL_ONLY_CALL_LOG_LIMIT) missedCallLog.shift();
    store.appendMissedCallEntry(entry).catch(() => {});
  }
  broadcastQueue();
}

// ======================================================================
// Call transfer — an agent on an active call can hand it back into the
// queue instead of ending it: the guest never hangs up, they just see a
// "connecting you to another agent" wait (same as their original wait,
// see kiosk.js's 'call-transferring' handler) while the call goes back
// into the queue, filtered to agents who speak the (possibly corrected)
// target language, with a short note for whoever picks it up next. This
// deliberately reuses the *answer* path (answer-call / call-assigned /
// call-accepted) rather than inventing a parallel one — a transferred
// call re-enters the queue exactly like a fresh one, just further along.
// ======================================================================

function transferCall(callId, { note, language, fromAgentName }) {
  const call = calls.get(callId);
  if (!call) return;
  clearHoldTimers(call);
  accumulateHoldTime(call); // in case the call was on hold when transferred

  // Log the outgoing agent's segment now, the same shape endCall() uses for
  // a normally-ended answered call, so Agent Performance / Recent Calls
  // credit them for the time they actually spent — outcome:'transferred'
  // distinguishes it from a call they saw through to the end themselves.
  if (call.answeredAt) {
    const entry = {
      callId,
      topic: call.topic,
      kioskId: call.kioskId,
      language: call.language,
      agentId: call.agentId || null,
      agentName: call.agentName || null,
      queuedAt: call.queuedAt,
      answeredAt: call.answeredAt,
      endedAt: Date.now(),
      notes: call.notes || '',
      outcome: 'transferred',
      holdSeconds: call.holdSecondsTotal || 0,
      holdCount: call.holdCount || 0,
      transferredFrom: call.transferredFrom || null,
    };
    callLog.push(entry);
    if (!store.configured && callLog.length > LOCAL_ONLY_CALL_LOG_LIMIT) callLog.shift();
    store.appendCallLogEntry(entry).catch(() => {});
  }

  const outgoingAgentConn = call.agentConn;

  // Reset the call back to "waiting for an agent" — notes, hold stats, and
  // the wait clock all start fresh for this next leg (the segment that just
  // ended already captured its own copies above), while the transfer
  // context carries forward so the next agent has it.
  call.language = enabledLanguageCodes().has(language) ? language : call.language;
  call.transferredFrom = fromAgentName;
  call.transferNote = note || null;
  call.transferCount = (call.transferCount || 0) + 1;
  call.agentConn = null;
  call.agentId = null;
  call.agentName = null;
  call.answeredAt = null;
  call.queuedAt = Date.now();
  call.notes = '';
  call.onHold = false;
  call.holdStartedAt = null;
  call.holdSecondsTotal = 0;
  call.holdCount = 0;

  // Unshift, not push — this guest already waited once; a transfer isn't
  // supposed to send them back to the end of the line.
  queue.unshift(callId);

  if (call.guestConn && call.guestConn.alive) {
    call.guestConn.send({ type: 'call-transferring' });
  }
  if (outgoingAgentConn && outgoingAgentConn.alive) {
    outgoingAgentConn.send({ type: 'call-transferred', callId });
  }
  for (const a of agentConns) {
    a.send({ type: 'call-log-changed' });
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

/**
 * Every call log entry belonging to one agent. Matches by agentId when the
 * entry has one (every call answered after this field was added); falls
 * back to matching by name for older entries recorded before that, so
 * pre-existing history doesn't just disappear from stats.
 */
function entriesForAgent(agent) {
  return callLog.filter((e) => (e.agentId ? e.agentId === agent.id : e.agentName === agent.name));
}

function statsForEntries(entries) {
  const totalTalkSeconds = entries.reduce((sum, e) => sum + Math.max(0, Math.round((e.endedAt - e.answeredAt) / 1000)), 0);
  const totalHoldSeconds = entries.reduce((sum, e) => sum + (e.holdSeconds || 0), 0);
  const totalHoldCount = entries.reduce((sum, e) => sum + (e.holdCount || 0), 0);
  const kiosks = new Map();
  let lastCallAt = 0;
  for (const e of entries) {
    // Kiosk, not topic, is the interesting breakdown now that every call is
    // the same "Front Desk" topic — this shows which kiosk keeps an agent busiest.
    if (e.kioskId) kiosks.set(e.kioskId, (kiosks.get(e.kioskId) || 0) + 1);
    lastCallAt = Math.max(lastCallAt, e.endedAt);
  }
  const callRatings = entries.map((e) => ratingForCall(e.callId)).filter(Boolean);
  const ratingCount = callRatings.length;
  const avgRating = ratingCount ? Math.round((callRatings.reduce((sum, r) => sum + r.stars, 0) / ratingCount) * 10) / 10 : null;
  return {
    calls: entries.length,
    totalTalkSeconds,
    avgTalkSeconds: entries.length ? Math.round(totalTalkSeconds / entries.length) : 0,
    totalHoldSeconds,
    totalHoldCount,
    topKiosk: [...kiosks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    lastCallAt: lastCallAt || null,
    avgRating,
    ratingCount,
  };
}

/** True if a call log entry's answeredAt falls within [from, to] — from/to of null/undefined leave that side unbounded. Shared by computeAgentStats() and computeAgentDetail() so the Agent Performance page's date-range filter and its per-agent detail view always agree. */
function answeredInRange(e, from, to) {
  if (Number.isFinite(from) && e.answeredAt < from) return false;
  if (Number.isFinite(to) && e.answeredAt > to) return false;
  return true;
}

/** Per-agent breakdown for the Agent Performance page. `from`/`to` (ms since epoch) optionally restrict it to calls answered in that range — omit both for all-time, the original behavior. */
function computeAgentStats(from, to) {
  const rows = AGENTS.map((a) => ({
    agentId: a.id,
    agentName: a.name,
    ...statsForEntries(entriesForAgent(a).filter((e) => answeredInRange(e, from, to))),
  }));

  // Calls from agents who've since been removed shouldn't just vanish from
  // the numbers — group those by name under an id-less row instead.
  const knownIds = new Set(AGENTS.map((a) => a.id));
  const knownNames = new Set(AGENTS.map((a) => a.name));
  const orphanEntriesByName = new Map();
  for (const e of callLog) {
    if (!answeredInRange(e, from, to)) continue;
    const belongsToKnownAgent = e.agentId ? knownIds.has(e.agentId) : knownNames.has(e.agentName);
    if (belongsToKnownAgent) continue;
    const name = e.agentName || 'Unknown';
    if (!orphanEntriesByName.has(name)) orphanEntriesByName.set(name, []);
    orphanEntriesByName.get(name).push(e);
  }
  for (const [name, entries] of orphanEntriesByName) {
    rows.push({ agentId: null, agentName: name, ...statsForEntries(entries) });
  }

  return rows.sort((a, b) => b.calls - a.calls);
}

/**
 * True if a call log entry matches the Dashboard's agent filter. `filterValue`
 * is either a known agent's id, or `name:<agentName>` for an agent that's
 * since been removed (the admin picks these from the same orphan rows
 * computeAgentStats() already groups by name — see there for why matching
 * falls back to name for entries recorded before `agentId` existed).
 */
function entryMatchesAgentFilter(e, filterValue) {
  if (!filterValue) return true;
  if (filterValue.startsWith('name:')) {
    const name = decodeURIComponent(filterValue.slice(5));
    const knownIds = new Set(AGENTS.map((a) => a.id));
    const knownNames = new Set(AGENTS.map((a) => a.name));
    const belongsToKnownAgent = e.agentId ? knownIds.has(e.agentId) : knownNames.has(e.agentName);
    if (belongsToKnownAgent) return false; // this name now belongs to a current agent — let their own id-based filter match instead
    return (e.agentName || 'Unknown') === name;
  }
  return e.agentId === filterValue;
}

/** The human-readable explanation of what the stats do/don't cover, shown under both the Dashboard and Agent Performance pages. */
function persistenceNote(storageStatus) {
  if (!storageStatus.configured) {
    return `Persistent storage isn't set up, so this only covers the last ${LOCAL_ONLY_CALL_LOG_LIMIT} calls and resets whenever the server restarts. See the README's "Persistent storage" section to make it permanent.`;
  }
  if (storageStatus.connected) {
    return 'Stats cover all-time call history, persisted to Redis — this survives restarts and redeploys.';
  }
  return 'Persistent storage is configured but not reachable right now, so this may be missing recent history and changes might not be saved. Check the Upstash database and the server logs.';
}

/**
 * R2's Standard storage free tier, in bytes — used only as a helpful
 * reference point for the admin dashboard's storage meter. R2 doesn't
 * enforce a hard quota at this line the way a fixed disk would: it's
 * billed usage (like S3), so going over it means a small monthly charge
 * ($0.015/GB-month), not a blocked upload. See the README's "Call
 * recordings" section.
 */
const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB-month

/** Sums the size of every file directly under recordings/ (the local-disk fallback used when R2 isn't configured). */
async function getLocalRecordingsDiskUsage() {
  let bytesUsed = 0;
  let objectCount = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(RECORDINGS_DIR, { withFileTypes: true });
  } catch (err) {
    return { bytesUsed: 0, objectCount: 0, error: err.message };
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'index.json') continue;
    try {
      const stat = await fs.promises.stat(path.join(RECORDINGS_DIR, entry.name));
      bytesUsed += stat.size;
      objectCount += 1;
    } catch {
      // file disappeared mid-scan (e.g. cleaned up concurrently) — skip it
    }
  }
  return { bytesUsed, objectCount };
}

/**
 * Storage usage for the admin dashboard's Configuration page: actual R2
 * usage (listing the bucket) when R2 is configured, otherwise the local
 * recordings/ directory — which is what's actually holding recordings on
 * this server, and which the README already warns is wiped by every
 * restart/redeploy on Render's ephemeral disk.
 */
async function getStorageUsage() {
  if (r2.configured) {
    try {
      const { bytesUsed, objectCount } = await r2.getStorageSummary();
      return { backend: 'r2', bytesUsed, objectCount, freeTierBytes: R2_FREE_TIER_BYTES };
    } catch (err) {
      return { backend: 'r2', error: err.message, freeTierBytes: R2_FREE_TIER_BYTES };
    }
  }
  const local = await getLocalRecordingsDiskUsage();
  return { backend: 'local', freeTierBytes: null, ...local };
}

/** Full call history + totals for one agent, including recording links — the admin dashboard's agent-detail view. `from`/`to` optionally restrict it to the same date range as the Agent Performance page's filter, so the numbers in the detail modal always match the row/bar the admin clicked. */
async function computeAgentDetail(agent, from, to) {
  const entries = entriesForAgent(agent)
    .filter((e) => answeredInRange(e, from, to))
    .sort((a, b) => b.answeredAt - a.answeredAt);
  // Existence checks run in parallel (one per call that has a recording at
  // all — recordingForCall() returns immediately for the rest) rather than
  // one at a time, so a long-serving agent's full history doesn't turn this
  // into a slow serial chain of R2 round trips.
  const calls = await Promise.all(
    entries.map(async (e) => ({ ...e, recording: await recordingForCall(e.callId), rating: ratingForCall(e.callId) }))
  );
  return {
    agent: { id: agent.id, name: agent.name },
    totals: statsForEntries(entries),
    calls,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
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

// ======================================================================
// Public call config — the agent dashboard shows the configured max hold
// duration next to the Hold button (so an agent knows the limit before
// they hit it, not just when the 30s warning arrives). No admin auth here,
// same reasoning as TURN credentials above: it only ever reveals a
// duration in seconds, nothing sensitive.
// ======================================================================

function handleCallConfig(req, res) {
  // `languages` is scoped to what's actually usable right now — only
  // languages at least one configured agent is tagged for (not just who's
  // currently online: an agent who's briefly signed off still counts, so
  // this doesn't flicker as people log in and out). This is what the kiosk's
  // language picker and an agent's Transfer-target dropdown show, since
  // offering a language nobody on the roster speaks would be a dead end.
  // `allLanguages` is every language the admin currently has enabled
  // (Configuration > Languages), regardless of who's tagged for what — the
  // admin dashboard needs that one, so a property can tag its first agent
  // for a language nobody's using yet, without being limited to `languages`.
  const activeCodes = new Set();
  for (const a of AGENTS) {
    if (Array.isArray(a.languages)) for (const code of a.languages) activeCodes.add(code);
  }
  const enabled = supportedLanguages();
  let languages = enabled.filter((l) => activeCodes.has(l.code));
  if (!languages.length) languages = enabled.filter((l) => l.code === DEFAULT_LANGUAGE); // safety net if somehow no agent has any language tagged (e.g. every agent was just deleted)
  sendJson(res, 200, { maxHoldSeconds: CONFIG.maxHoldSeconds, logoSizePx: CONFIG.logoSizePx, languages, allLanguages: enabled });
}

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
// Call recordings — this server never sees a call's live audio/video (it's
// peer-to-peer, or TURN-relayed without ever touching this process — see
// turn.js), so a recording has to be captured client-side, in the agent's
// browser: it composites the remote + local video onto a canvas, mixes
// both audio tracks, and runs that through MediaRecorder. The resulting
// webm chunks get uploaded here as the call happens and staged to a local
// file under recordings/ while the call is in progress — that staging
// step happens either way, so a recording still exists locally even if
// the next step (below) fails.
//
// Where a *finished* recording ends up depends on whether Cloudflare R2
// is configured (see r2.js):
//   - R2 configured: the staged file is uploaded to R2 as one object and
//     the local copy is deleted — this is what actually persists across
//     redeploys/restarts. See the README's "Call recordings" section for
//     setup.
//   - Not configured (the default): the file just stays on local disk,
//     indexed in recordings/index.json — simple, no extra account needed,
//     but NOT persistent on most Render plans, same caveat as
//     agents.json without Redis configured.
// An R2 upload failure at finish time falls back to keeping the local
// copy rather than losing the recording.
// ======================================================================

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
try {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
} catch (err) {
  console.error('[recordings] could not create the recordings/ directory:', err.message);
}
const RECORDINGS_INDEX_FILE = path.join(RECORDINGS_DIR, 'index.json');

function loadRecordingsIndex() {
  try {
    return JSON.parse(fs.readFileSync(RECORDINGS_INDEX_FILE, 'utf8'));
  } catch {
    return [];
  }
}
/** [{ callId, backend: 'local'|'r2', filename?, key?, mimeType, bytes, startedAt, finishedAt }] — newest last. */
let recordingsIndex = loadRecordingsIndex();

function saveRecordingsIndex() {
  try {
    fs.writeFileSync(RECORDINGS_INDEX_FILE, JSON.stringify(recordingsIndex, null, 2));
  } catch (err) {
    console.error('[recordings] could not write recordings/index.json (non-fatal):', err.message);
  }
}

// A presigned R2 URL has to carry an expiry, so it's never stored — it's
// minted fresh every time a call log is requested. An hour is generous for
// one viewing session without leaving a link usable long after.
const RECORDING_URL_TTL_SECONDS = 60 * 60;

/**
 * Returns { url, bytes, mimeType } for a finished recording of this call,
 * { missing: true, bytes, mimeType } if one was recorded but the
 * underlying file/object is gone (deleted directly from R2, or off local
 * disk by hand — this app never deletes a recording out from under its own
 * index except via deleteObject() cleanup, so this only fires on outside
 * deletion), or null if there isn't one (yet, or ever).
 */
async function recordingForCall(callId) {
  // Recordings finish uploading slightly after the call itself ends (the
  // agent's browser has to flush the last chunk), so the most recent call
  // in the log may briefly have no recording here yet.
  const entry = recordingsIndex.find((r) => r.callId === callId);
  if (!entry) return null;

  if (entry.backend === 'r2') {
    let url;
    try {
      url = r2.getPresignedUrl(entry.key, RECORDING_URL_TTL_SECONDS);
    } catch (err) {
      console.error('[recordings] could not mint an R2 playback URL:', err.message);
      return null;
    }
    try {
      const exists = await r2.headObject(entry.key);
      if (!exists) return { missing: true, bytes: entry.bytes, mimeType: entry.mimeType };
    } catch (err) {
      // Couldn't confirm either way (network blip, a token that can read
      // objects but not HEAD them, etc.) — don't hide a recording that
      // might still be there just because this one check failed; log it
      // and fall through to handing back the link as usual.
      console.error(`[recordings] could not verify ${entry.key} still exists in R2 (showing the link anyway):`, err.message);
    }
    return { url, bytes: entry.bytes, mimeType: entry.mimeType };
  }

  const localPath = path.join(RECORDINGS_DIR, entry.filename);
  if (!fs.existsSync(localPath)) {
    return { missing: true, bytes: entry.bytes, mimeType: entry.mimeType };
  }
  return {
    url: `/api/recordings/file/${encodeURIComponent(entry.filename)}`,
    bytes: entry.bytes,
    mimeType: entry.mimeType,
  };
}

// callId -> { stream, filename, mimeType, bytes, startedAt } — recordings
// currently being uploaded in chunks, one at a time per call.
const activeRecordings = new Map();
// A generous per-call safety cap, not a real limit — a hotel front-desk
// call running this long would be very unusual, but an open-ended upload
// endpoint shouldn't be able to fill the disk.
const MAX_RECORDING_BYTES = 750 * 1024 * 1024;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Turns an agent/kiosk name into a filesystem-safe slug for the recording filename below. */
function slugForFilename(raw, fallback) {
  const slug = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Recording filenames read as `agent-kiosk-ddmmyyyy-hhmm.webm` — meant to
 * be identifiable at a glance in a file browser or the R2 dashboard,
 * without having to open the app. The date/time reflects the server's own
 * local timezone (Node's default `Date` behavior) — set the `TZ`
 * environment variable to your hotel's timezone (e.g.
 * `Asia/Kuala_Lumpur`) if the server's default doesn't already match, so
 * filenames read in local time rather than UTC.
 *
 * This runs once per call, right when its first recording chunk arrives.
 * Usually that's mid-call, while `calls` still has the live entry
 * (agentName is set there as soon as `answer-call` runs, kioskId since the
 * call was created). But for a very short call, the browser may not flush
 * any chunk until the call is already wrapping up — by then `endCall()`
 * has deleted the `calls` entry and pushed the finished call into
 * `callLog` instead, so that's the fallback rather than silently landing
 * on a generic "agent-kiosk" name.
 */
function safeRecordingFilename(callId) {
  const call = calls.get(callId) || callLog.find((e) => e.callId === callId);
  const agentSlug = slugForFilename(call?.agentName, 'agent');
  const kioskSlug = slugForFilename(call?.kioskId, 'kiosk');
  const now = new Date();
  const dateStamp = `${pad2(now.getDate())}${pad2(now.getMonth() + 1)}${now.getFullYear()}`;
  const timeStamp = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const base = `${agentSlug}-${kioskSlug}-${dateStamp}-${timeStamp}`;

  // Two recordings can land on the same agent+kiosk+minute (the same agent
  // taking back-to-back calls at the same kiosk) — append a numeric suffix
  // rather than silently overwrite an earlier recording of the same name.
  // Checked against both local disk and the in-memory index, since a
  // finished recording may already be on R2 with its local copy deleted.
  let filename = `${base}.webm`;
  let n = 2;
  while (
    fs.existsSync(path.join(RECORDINGS_DIR, filename)) ||
    recordingsIndex.some((r) => r.filename === filename)
  ) {
    filename = `${base}-${n}.webm`;
    n += 1;
  }
  return filename;
}

async function handleRecordingChunk(req, res, urlObj) {
  const callId = Number(urlObj.searchParams.get('callId'));
  if (!Number.isInteger(callId) || callId <= 0) {
    sendJson(res, 400, { error: 'invalid or missing callId' });
    return;
  }

  let rec = activeRecordings.get(callId);
  if (!rec) {
    const filename = safeRecordingFilename(callId);
    rec = {
      filename,
      mimeType: (req.headers['content-type'] || 'video/webm').split(';')[0].trim() || 'video/webm',
      bytes: 0,
      startedAt: Date.now(),
      stream: fs.createWriteStream(path.join(RECORDINGS_DIR, filename)),
    };
    activeRecordings.set(callId, rec);
  }

  const chunks = [];
  let total = 0;
  let tooLarge = false;
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      total += chunk.length;
      if (rec.bytes + total > MAX_RECORDING_BYTES) {
        tooLarge = true;
        req.destroy();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', resolve);
  });

  if (tooLarge) {
    sendJson(res, 413, { error: 'recording too large' });
    return;
  }

  const buf = Buffer.concat(chunks);
  if (buf.length) {
    rec.bytes += buf.length;
    rec.stream.write(buf);
  }
  sendJson(res, 200, { ok: true, bytes: rec.bytes });
}

async function handleRecordingFinish(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
  const callId = Number(body.callId);
  const rec = activeRecordings.get(callId);
  if (!rec) {
    // Nothing was ever uploaded for this call (e.g. it never actually
    // connected) — not an error, just nothing to finalize.
    sendJson(res, 200, { ok: true, recorded: false });
    return;
  }
  activeRecordings.delete(callId);
  await new Promise((resolve) => rec.stream.end(resolve));

  if (rec.bytes === 0) {
    // Nothing was actually captured — remove the empty file rather than
    // leaving clutter in recordings/.
    fs.unlink(path.join(RECORDINGS_DIR, rec.filename), () => {});
    sendJson(res, 200, { ok: true, recorded: false });
    return;
  }

  const localPath = path.join(RECORDINGS_DIR, rec.filename);

  if (r2.configured) {
    try {
      // The whole call was already staged to local disk above as it came
      // in (that write-through gives us a recording even if this upload
      // fails); a front-desk call is short enough that reading it back
      // into memory for one PutObject is cheap — no need for S3 multipart
      // upload, whose 5MB-per-part minimum doesn't fit these 2-second
      // chunks anyway.
      const buffer = await fs.promises.readFile(localPath);
      const key = `recordings/${rec.filename}`;
      await r2.putObject(key, buffer, rec.mimeType);
      fs.unlink(localPath, () => {}); // uploaded — the local copy was only a staging buffer
      recordingsIndex.push({
        callId, key, mimeType: rec.mimeType, bytes: rec.bytes,
        startedAt: rec.startedAt, finishedAt: Date.now(), backend: 'r2',
      });
      saveRecordingsIndex();
      sendJson(res, 200, { ok: true, recorded: true, backend: 'r2' });
      return;
    } catch (err) {
      console.error('[recordings] R2 upload failed, keeping this one on local disk instead:', err.message);
      // Fall through — the file is already sitting on local disk from the
      // chunked writes above, so index it there rather than losing it.
    }
  }

  recordingsIndex.push({
    callId, filename: rec.filename, mimeType: rec.mimeType, bytes: rec.bytes,
    startedAt: rec.startedAt, finishedAt: Date.now(), backend: 'local',
  });
  saveRecordingsIndex();
  sendJson(res, 200, { ok: true, recorded: true, backend: 'local' });
}

/** Serves a recording file with Range support, so the <video> player in the dashboards can seek. */
function handleRecordingFile(req, res, rawFilename) {
  let filename;
  try { filename = decodeURIComponent(rawFilename); } catch { res.writeHead(400).end('bad request'); return; }
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    res.writeHead(400).end('bad request');
    return;
  }
  const filePath = path.join(RECORDINGS_DIR, filename);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'video/webm',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ======================================================================
// Call ratings — after a call ends, the kiosk offers the guest a 1-5 star
// rating with an optional name and remarks (see kiosk.js's "ended" screen).
// Ratings are keyed by callId and folded into the matching call log entry
// wherever one's shown (agent call log, admin stats, admin agent detail) —
// same pattern as recordings via recordingForCall() above. This endpoint is
// intentionally unauthenticated (a guest submitting it has no account to
// authenticate with, same reasoning as the password-reset endpoint), but it
// only accepts a rating for a callId that's actually in the call log — a
// real, already-ended call — so it can't be used to inject arbitrary
// standalone data.
// ======================================================================

/** callId -> { callId, stars, guestName, remarks, ratedAt } */
const ratings = new Map();
const RATING_REMARKS_MAX_LENGTH = 500;
const RATING_NAME_MAX_LENGTH = 60;

/** Returns the rating for this call, or null if it hasn't been rated (yet, or ever). */
function ratingForCall(callId) {
  return ratings.get(callId) || null;
}

async function handleSubmitRating(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }

  const callId = Number(body.callId);
  const stars = Math.round(Number(body.stars));
  if (!Number.isInteger(callId) || callId <= 0) { sendJson(res, 400, { error: 'invalid or missing callId' }); return; }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) { sendJson(res, 400, { error: 'stars must be an integer from 1 to 5' }); return; }
  if (!callLog.some((e) => e.callId === callId)) {
    // Either this callId never happened, or (more likely in practice) the
    // rating request raced the call-log write on call end — either way,
    // there's nothing to attach it to.
    sendJson(res, 404, { error: 'no completed call with that id' });
    return;
  }

  const rating = {
    callId,
    stars,
    guestName: String(body.guestName || '').trim().slice(0, RATING_NAME_MAX_LENGTH),
    remarks: String(body.remarks || '').trim().slice(0, RATING_REMARKS_MAX_LENGTH),
    ratedAt: Date.now(),
  };
  ratings.set(callId, rating);
  store.persistRating(rating).catch(() => {});
  sendJson(res, 200, { ok: true });
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
    const languages = normalizeLanguages(body.languages);
    AGENTS.push({ id: crypto.randomUUID(), name, password, languages: languages.length ? languages : [DEFAULT_LANGUAGE] });
    const persisted = await saveAgents();
    sendJson(res, 201, { agents: AGENTS, persisted, persistenceConfigured: store.configured, languages: supportedLanguages() });
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

  // Update which language(s) an agent is tagged for — a separate endpoint
  // (rather than folding into a general agent-edit one, which doesn't exist
  // yet) so the admin dashboard's per-agent language chips can save with a
  // single, focused request the moment one is toggled.
  const languagesMatch = urlObj.pathname.match(/^\/api\/admin\/agents\/([^/]+)\/languages$/);
  if (languagesMatch && req.method === 'POST') {
    const id = decodeURIComponent(languagesMatch[1]);
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) { sendJson(res, 404, { error: 'no agent with that id' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const languages = normalizeLanguages(body.languages);
    if (!languages.length) { sendJson(res, 400, { error: 'at least one language is required' }); return; }
    agent.languages = languages;
    const persisted = await saveAgents();
    sendJson(res, 200, { agents: AGENTS, persisted, persistenceConfigured: store.configured });
    return;
  }

  // Directly set an agent's password — same validation as the password-reset
  // flow's resolve step (see resolveResetMatch below), but callable any time
  // rather than only against a pending reset request, for when an admin just
  // wants to rotate a password proactively.
  const agentPasswordMatch = urlObj.pathname.match(/^\/api\/admin\/agents\/([^/]+)\/password$/);
  if (agentPasswordMatch && req.method === 'POST') {
    const id = decodeURIComponent(agentPasswordMatch[1]);
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) { sendJson(res, 404, { error: 'no agent with that id' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const password = String(body.password || '').trim().slice(0, 60);
    if (password.length < 4) { sendJson(res, 400, { error: 'password must be at least 4 characters' }); return; }
    if (AGENTS.some((a) => a.id !== id && a.password === password)) {
      sendJson(res, 409, { error: 'that password is already in use by another agent' });
      return;
    }
    agent.password = password;
    const persisted = await saveAgents();
    sendJson(res, 200, { agents: AGENTS, persisted, persistenceConfigured: store.configured });
    return;
  }

  const agentDetailMatch = urlObj.pathname.match(/^\/api\/admin\/agents\/([^/]+)\/detail$/);
  if (agentDetailMatch && req.method === 'GET') {
    const id = decodeURIComponent(agentDetailMatch[1]);
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) { sendJson(res, 404, { error: 'no agent with that id' }); return; }
    const fromParam = urlObj.searchParams.get('from');
    const toParam = urlObj.searchParams.get('to');
    const from = fromParam ? Number(fromParam) : null;
    const to = toParam ? Number(toParam) : null;
    sendJson(res, 200, await computeAgentDetail(agent, from, to));
    return;
  }

  // Kiosk accounts — same shape as the agents endpoints above, plus a
  // `sessionActive` flag (derived from kioskSessions, never persisted) so
  // the admin dashboard can show which kiosks are currently signed in, and
  // a force-logout action to reclaim a session (e.g. a kiosk device that
  // was powered off without signing out first).
  if (urlObj.pathname === '/api/admin/kiosks' && req.method === 'GET') {
    sendJson(res, 200, {
      kiosks: KIOSKS.map((k) => ({ ...k, sessionActive: kioskSessions.has(k.id) })),
    });
    return;
  }

  if (urlObj.pathname === '/api/admin/kiosks' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const name = String(body.name || '').trim().slice(0, 60);
    const password = String(body.password || '').trim().slice(0, 60);
    if (!name || !password) { sendJson(res, 400, { error: 'name and password are both required' }); return; }
    if (password.length < 4) { sendJson(res, 400, { error: 'password must be at least 4 characters' }); return; }
    if (KIOSKS.some((k) => k.password === password)) { sendJson(res, 409, { error: 'that password is already in use' }); return; }
    const kiosk = { id: crypto.randomUUID(), name, password };
    KIOSKS.push(kiosk);
    const persisted = await saveKiosks();
    sendJson(res, 201, {
      kiosks: KIOSKS.map((k) => ({ ...k, sessionActive: kioskSessions.has(k.id) })),
      persisted,
      persistenceConfigured: store.configured,
    });
    return;
  }

  const kioskDeleteMatch = urlObj.pathname.match(/^\/api\/admin\/kiosks\/([^/]+)$/);
  if (kioskDeleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(kioskDeleteMatch[1]);
    const before = KIOSKS.length;
    KIOSKS = KIOSKS.filter((k) => k.id !== id);
    if (KIOSKS.length === before) { sendJson(res, 404, { error: 'no kiosk with that id' }); return; }
    const activeConn = kioskSessions.get(id);
    if (activeConn) {
      activeConn.send({ type: 'kiosk-forced-logout', reason: 'account-removed' });
      activeConn.close();
      kioskSessions.delete(id);
    }
    // Clean up any branding images this kiosk had uploaded — nothing else
    // references them once the account itself is gone.
    try { fs.rmSync(path.join(KIOSK_BRANDING_DIR, id), { recursive: true, force: true }); } catch { /* non-fatal */ }
    const persisted = await saveKiosks();
    sendJson(res, 200, {
      kiosks: KIOSKS.map((k) => ({ ...k, sessionActive: kioskSessions.has(k.id) })),
      persisted,
      persistenceConfigured: store.configured,
    });
    return;
  }

  // Per-kiosk branding — logo, background photo, and/or accent color
  // overriding the global kiosk.css defaults for just this kiosk account.
  // Accepts base64 data URLs rather than multipart form data, matching
  // this project's zero-dependency approach (no multipart parser). Any
  // field left out of the body is untouched; `removeLogo`/
  // `removeBackground` clear that one override back to the global default.
  const kioskBrandingMatch = urlObj.pathname.match(/^\/api\/admin\/kiosks\/([^/]+)\/branding$/);
  if (kioskBrandingMatch && req.method === 'POST') {
    const id = decodeURIComponent(kioskBrandingMatch[1]);
    const kiosk = KIOSKS.find((k) => k.id === id);
    if (!kiosk) { sendJson(res, 404, { error: 'no kiosk with that id' }); return; }

    let body;
    try {
      body = await readJsonBody(req, MAX_BRANDING_UPLOAD_BYTES);
    } catch (err) {
      const tooLarge = err.message === 'body too large';
      sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Upload too large (max 8MB).' : 'invalid JSON' });
      return;
    }

    const branding = { ...(kiosk.branding || {}) };
    const kioskDir = path.join(KIOSK_BRANDING_DIR, id);

    try {
      if (body.removeLogo) {
        clearBrandingFile(kioskDir, 'logo');
        delete branding.logoUrl;
      } else if (body.logo && body.logo.dataUrl) {
        const { buf, ext } = decodeBrandingImage(body.logo.dataUrl, { allowSvg: true });
        fs.mkdirSync(kioskDir, { recursive: true });
        clearBrandingFile(kioskDir, 'logo');
        fs.writeFileSync(path.join(kioskDir, `logo${ext}`), buf);
        branding.logoUrl = `/branding/kiosks/${id}/logo${ext}?v=${Date.now()}`;
      }

      if (body.removeBackground) {
        clearBrandingFile(kioskDir, 'background');
        delete branding.backgroundUrl;
      } else if (body.background && body.background.dataUrl) {
        const { buf, ext } = decodeBrandingImage(body.background.dataUrl, { allowSvg: false });
        fs.mkdirSync(kioskDir, { recursive: true });
        clearBrandingFile(kioskDir, 'background');
        fs.writeFileSync(path.join(kioskDir, `background${ext}`), buf);
        branding.backgroundUrl = `/branding/kiosks/${id}/background${ext}?v=${Date.now()}`;
      }

      if (body.accentColor !== undefined) {
        const color = String(body.accentColor || '').trim();
        if (!color) {
          delete branding.accentColor;
        } else if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          sendJson(res, 400, { error: 'accentColor must be a hex color like #016FB7' });
          return;
        } else {
          branding.accentColor = color;
        }
      }
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    if (Object.keys(branding).length) kiosk.branding = branding;
    else delete kiosk.branding;

    const persisted = await saveKiosks();
    // If this kiosk is currently signed in, push the updated branding to
    // it live — otherwise an admin's change wouldn't show up until the
    // device happens to sign out and back in.
    const activeConn = kioskSessions.get(id);
    if (activeConn) activeConn.send({ type: 'kiosk-branding-updated', branding: kiosk.branding || {} });
    sendJson(res, 200, {
      kiosks: KIOSKS.map((k) => ({ ...k, sessionActive: kioskSessions.has(k.id) })),
      persisted,
      persistenceConfigured: store.configured,
    });
    return;
  }

  // Directly set a kiosk account's password. Unlike an agent's password
  // change, this also force-signs-out any device currently signed in on
  // that account: its live connection would keep working (auth is only
  // checked at login time), but its stored password for auto-relogin on
  // the next reconnect would silently stop working — better to sign it out
  // now with a clear reason than have it mysteriously fail to reconnect
  // later.
  const kioskPasswordMatch = urlObj.pathname.match(/^\/api\/admin\/kiosks\/([^/]+)\/password$/);
  if (kioskPasswordMatch && req.method === 'POST') {
    const id = decodeURIComponent(kioskPasswordMatch[1]);
    const kiosk = KIOSKS.find((k) => k.id === id);
    if (!kiosk) { sendJson(res, 404, { error: 'no kiosk with that id' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const password = String(body.password || '').trim().slice(0, 60);
    if (password.length < 4) { sendJson(res, 400, { error: 'password must be at least 4 characters' }); return; }
    if (KIOSKS.some((k) => k.id !== id && k.password === password)) {
      sendJson(res, 409, { error: 'that password is already in use by another kiosk' });
      return;
    }
    kiosk.password = password;
    const persisted = await saveKiosks();
    const activeConn = kioskSessions.get(id);
    if (activeConn) {
      activeConn.send({ type: 'kiosk-forced-logout', reason: 'admin' });
      activeConn.close();
      kioskSessions.delete(id);
    }
    sendJson(res, 200, {
      kiosks: KIOSKS.map((k) => ({ ...k, sessionActive: kioskSessions.has(k.id) })),
      persisted,
      persistenceConfigured: store.configured,
    });
    return;
  }

  const kioskForceLogoutMatch = urlObj.pathname.match(/^\/api\/admin\/kiosks\/([^/]+)\/force-logout$/);
  if (kioskForceLogoutMatch && req.method === 'POST') {
    const id = decodeURIComponent(kioskForceLogoutMatch[1]);
    const kiosk = KIOSKS.find((k) => k.id === id);
    if (!kiosk) { sendJson(res, 404, { error: 'no kiosk with that id' }); return; }
    const activeConn = kioskSessions.get(id);
    if (!activeConn) { sendJson(res, 200, { ok: true, wasActive: false }); return; }
    activeConn.send({ type: 'kiosk-forced-logout', reason: 'admin' });
    activeConn.close();
    kioskSessions.delete(id);
    sendJson(res, 200, { ok: true, wasActive: true });
    return;
  }

  if (urlObj.pathname === '/api/admin/config' && req.method === 'GET') {
    sendJson(res, 200, {
      config: CONFIG,
      min: MIN_HOLD_SECONDS,
      max: MAX_HOLD_SECONDS,
      minLogoSizePx: MIN_LOGO_SIZE_PX,
      maxLogoSizePx: MAX_LOGO_SIZE_PX,
    });
    return;
  }

  // Each field below is independently optional — the hold-duration form and
  // the logo-size form (see admin.js) each save just their own field, so
  // neither has to resend a value it isn't editing.
  if (urlObj.pathname === '/api/admin/config' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    const next = { ...CONFIG };

    if (body.maxHoldSeconds !== undefined) {
      const maxHoldSeconds = Math.round(Number(body.maxHoldSeconds));
      if (!Number.isFinite(maxHoldSeconds) || maxHoldSeconds < MIN_HOLD_SECONDS || maxHoldSeconds > MAX_HOLD_SECONDS) {
        sendJson(res, 400, { error: `maxHoldSeconds must be a number between ${MIN_HOLD_SECONDS} and ${MAX_HOLD_SECONDS}` });
        return;
      }
      next.maxHoldSeconds = maxHoldSeconds;
    }

    if (body.logoSizePx !== undefined) {
      const logoSizePx = Math.round(Number(body.logoSizePx));
      if (!Number.isFinite(logoSizePx) || logoSizePx < MIN_LOGO_SIZE_PX || logoSizePx > MAX_LOGO_SIZE_PX) {
        sendJson(res, 400, { error: `logoSizePx must be a number between ${MIN_LOGO_SIZE_PX} and ${MAX_LOGO_SIZE_PX}` });
        return;
      }
      next.logoSizePx = logoSizePx;
    }

    CONFIG = next;
    const persisted = await saveConfig();
    sendJson(res, 200, { config: CONFIG, persisted, persistenceConfigured: store.configured });
    return;
  }

  // The full world-language catalog, each flagged with whether it's
  // currently enabled — powers the dashboard's Configuration > Languages
  // panel, where a property turns languages on/off without touching code.
  if (urlObj.pathname === '/api/admin/languages' && req.method === 'GET') {
    const enabled = enabledLanguageCodes();
    sendJson(res, 200, {
      languages: WORLD_LANGUAGES.map((l) => ({ ...l, enabled: enabled.has(l.code) })),
      defaultLanguage: DEFAULT_LANGUAGE,
    });
    return;
  }

  if (urlObj.pathname === '/api/admin/languages' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
    if (!Array.isArray(body.enabled)) { sendJson(res, 400, { error: '"enabled" must be an array of language codes' }); return; }
    const requested = new Set(body.enabled.filter((c) => WORLD_LANGUAGE_CODES.has(c)));
    requested.add(DEFAULT_LANGUAGE); // can't be turned off — every install needs at least one guaranteed language

    // Refuse to disable a language some agent is still tagged with — that
    // agent would silently lose a language guests can no longer pick or tag
    // them for. Ask the admin to retag those agents first instead of
    // quietly breaking their assignment.
    const stillInUse = new Map(); // code -> [agent names]
    for (const a of AGENTS) {
      if (!Array.isArray(a.languages)) continue;
      for (const code of a.languages) {
        if (!requested.has(code)) {
          if (!stillInUse.has(code)) stillInUse.set(code, []);
          stillInUse.get(code).push(a.name);
        }
      }
    }
    if (stillInUse.size) {
      const detail = [...stillInUse.entries()].map(([code, names]) => `${languageLabel(code)} (${names.join(', ')})`).join('; ');
      sendJson(res, 409, { error: `Can't disable a language still assigned to an agent — retag them first: ${detail}` });
      return;
    }

    CONFIG = { ...CONFIG, enabledLanguages: [...requested] };
    const persisted = await saveConfig();
    sendJson(res, 200, {
      languages: WORLD_LANGUAGES.map((l) => ({ ...l, enabled: requested.has(l.code) })),
      persisted,
      persistenceConfigured: store.configured,
    });
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

  // The `agents` breakdown optionally takes the same from/to (ms since
  // epoch) as the Dashboard's overview endpoint, for the Agent Performance
  // page's own date-range filter — omit both for all-time (the default, and
  // the only behavior before that filter existed). `totals` is always live,
  // current-moment state (who's online/waiting/on a call right now), so it's
  // never affected by the filter.
  if (urlObj.pathname === '/api/admin/stats' && req.method === 'GET') {
    const fromParam = urlObj.searchParams.get('from');
    const toParam = urlObj.searchParams.get('to');
    const from = fromParam ? Number(fromParam) : null;
    const to = toParam ? Number(toParam) : null;
    const storageStatus = store.getStatus();
    sendJson(res, 200, {
      agents: computeAgentStats(from, to),
      totals: {
        calls: callLog.length,
        agentsOnline: agentConns.size,
        guestsWaiting: queue.length,
        activeCalls: calls.size,
      },
      storage: storageStatus,
      note: persistenceNote(storageStatus),
    });
    return;
  }

  // Dashboard: combined call stats filterable by date range, agent, and
  // kiosk. The client resolves whatever preset/custom range it's showing
  // into explicit from/to timestamps (ms since epoch) — this endpoint just
  // filters callLog against them, plus the agent/kiosk filters, and hands
  // back both the totals (via the same statsForEntries() used everywhere
  // else, so the numbers always agree) and the raw matching entries, which
  // the client buckets by day/month itself (in the admin's own timezone —
  // bucketing this server-side would mean guessing a timezone to use).
  if (urlObj.pathname === '/api/admin/stats/overview' && req.method === 'GET') {
    const params = urlObj.searchParams;
    const fromParam = params.get('from');
    const toParam = params.get('to');
    const agentFilter = params.get('agentId') || '';
    const kioskFilter = params.get('kioskId') || '';
    const from = fromParam ? Number(fromParam) : null;
    const to = toParam ? Number(toParam) : null;

    const filtered = callLog.filter((e) => {
      if (Number.isFinite(from) && e.answeredAt < from) return false;
      if (Number.isFinite(to) && e.answeredAt > to) return false;
      if (kioskFilter && e.kioskId !== kioskFilter) return false;
      if (!entryMatchesAgentFilter(e, agentFilter)) return false;
      return true;
    });

    const entries = filtered
      .slice()
      .sort((a, b) => b.answeredAt - a.answeredAt)
      .map((e) => ({
        callId: e.callId,
        topic: e.topic,
        kioskId: e.kioskId,
        agentId: e.agentId,
        agentName: e.agentName,
        answeredAt: e.answeredAt,
        endedAt: e.endedAt,
        holdSeconds: e.holdSeconds,
        holdCount: e.holdCount,
        rating: ratingForCall(e.callId),
      }));

    const kioskSet = new Set();
    for (const e of callLog) if (e.kioskId) kioskSet.add(e.kioskId);
    for (const e of missedCallLog) if (e.kioskId) kioskSet.add(e.kioskId);

    // Calls that never got answered at all (guest gave up waiting, or lost
    // their connection before an agent picked up) — kept out of callLog
    // entirely (see missedCallLog's comment), so counted here from its own
    // list instead. There's no agent to filter these by (they never had
    // one), so picking a specific agent zeroes this out rather than
    // attributing someone else's missed calls to them.
    const missedFiltered = agentFilter
      ? []
      : missedCallLog.filter((e) => {
          if (Number.isFinite(from) && e.queuedAt < from) return false;
          if (Number.isFinite(to) && e.queuedAt > to) return false;
          if (kioskFilter && e.kioskId !== kioskFilter) return false;
          return true;
        });

    sendJson(res, 200, {
      totals: { ...statsForEntries(filtered), notAnswered: missedFiltered.length },
      entries,
      filters: {
        agents: computeAgentStats().map((r) => ({
          value: r.agentId || `name:${encodeURIComponent(r.agentName)}`,
          label: r.agentName,
        })),
        kiosks: [...kioskSet].sort(),
      },
      note: persistenceNote(store.getStatus()),
    });
    return;
  }

  // Storage usage for the Configuration page's Storage panel. R2 has no
  // fixed capacity to report "space left" against, so this reports actual
  // usage (bytesUsed/objectCount) plus the 10GB free-tier figure as a
  // reference the client can turn into a meter.
  if (urlObj.pathname === '/api/admin/storage' && req.method === 'GET') {
    sendJson(res, 200, await getStorageUsage());
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function handleGuestConnection(conn) {
  let myCallId = null;
  // Set once this connection authenticates as a kiosk account (see
  // 'kiosk-login' below) — kioskAccountId keys kioskSessions (the
  // exclusivity lock), kioskName is the plain display string that's been
  // going into call.kioskId all along, now sourced from the authenticated
  // account instead of trusted at face value from the client.
  let kioskAccountId = null;
  let kioskName = null;
  allConns.add(conn);

  conn.onMessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'kiosk-login') {
      const match = KIOSKS.find((k) => k.password === String(msg.password || ''));
      if (!match) {
        conn.send({ type: 'kiosk-login-fail', reason: 'invalid-credentials' });
        return;
      }
      const existing = kioskSessions.get(match.id);
      // A page refresh tears down the old WebSocket and opens a brand-new
      // one, which immediately replays the stored password (see kiosk.js's
      // isReconnect auto-relogin). That new connection's login can easily
      // reach the server before the old socket's close has been detected
      // (TCP teardown isn't instant, and the keepalive/heartbeat interval
      // that catches a silently-dead socket runs on its own timer) — so
      // "existing session still registered" doesn't necessarily mean a
      // second, different device. sessionToken disambiguates: it's a value
      // only ever handed back to a connection that already authenticated
      // for this exact kiosk account, so a match here proves this is the
      // *same* login reconnecting, not a rival device guessing the
      // password, and it's safe to just take over the slot. No token (or a
      // mismatched one) means a genuinely separate login attempt, which
      // still gets the usual rejection while a session is active.
      const isSameSessionReconnect = !!(existing && msg.sessionToken && existing.kioskSessionToken === String(msg.sessionToken));
      if (existing && existing !== conn && !isSameSessionReconnect) {
        conn.send({ type: 'kiosk-login-fail', reason: 'already-active' });
        return;
      }
      kioskAccountId = match.id;
      kioskName = match.name;
      conn.kioskAccountId = kioskAccountId; // readable from outside this closure, same convention as conn.agentId
      // Keep the same token across a reconnect (rather than minting a new
      // one) so a second, later refresh still recognizes this as the same
      // session too, not just the first one.
      conn.kioskSessionToken = isSameSessionReconnect ? existing.kioskSessionToken : crypto.randomUUID();
      kioskSessions.set(kioskAccountId, conn);
      conn.send({ type: 'kiosk-login-ok', name: kioskName, branding: match.branding || {}, sessionToken: conn.kioskSessionToken });
      return;
    }

    if (!kioskAccountId) return; // must sign in first — everything below is a signed-in kiosk's own connection

    if (msg.type === 'kiosk-logout') {
      if (kioskSessions.get(kioskAccountId) === conn) kioskSessions.delete(kioskAccountId);
      if (myCallId) { endCall(myCallId, 'guest-disconnected'); myCallId = null; }
      conn.send({ type: 'kiosk-logout-ok' });
      kioskAccountId = null;
      kioskName = null;
      return;
    }

    if (msg.type === 'join-queue') {
      const callId = nextCallId++;
      myCallId = callId;
      calls.set(callId, {
        topic: (msg.topic || 'General').slice(0, 60),
        kioskId: kioskName,
        language: enabledLanguageCodes().has(msg.language) ? msg.language : DEFAULT_LANGUAGE,
        guestConn: conn,
        agentConn: null,
        agentName: null,
        queuedAt: Date.now(),
        answeredAt: null,
        notes: '',
        transferredFrom: null,
        transferNote: null,
        transferCount: 0,
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
    // Only clear the session lock if THIS connection still holds it — a
    // stale close firing after a newer login already replaced it (shouldn't
    // normally happen given the exclusivity check above, but costs nothing
    // to guard against) must not evict the new session.
    if (kioskAccountId && kioskSessions.get(kioskAccountId) === conn) kioskSessions.delete(kioskAccountId);
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
      conn.agentId = agentId; // readable from outside this closure — see agentLanguages()/broadcastQueue()
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
      // Defense in depth: the queue this agent was actually shown already
      // excludes calls in a language they don't speak (see broadcastQueue's
      // per-agent filtering / queueVisibleTo), but a stale client-side
      // queue snapshot (or a hand-crafted message) could still name a
      // callId this agent shouldn't be offered — re-check server-side
      // rather than trusting the client.
      if (!queueVisibleTo(call, conn)) {
        conn.send({ type: 'answer-failed', callId, reason: 'language-mismatch' });
        return;
      }
      // The queue-button guard in agent.js only stops a second answer from
      // the SAME browser tab (it checks its own local currentCallId) — it
      // has no idea this agent is also signed in elsewhere. Since an agent
      // password isn't tied to one device or tab, the same agent can be
      // logged in on a second phone/tablet/browser at the same time; without
      // this check, that second session could answer an entirely different
      // call and put one agent on two simultaneous video calls. Check across
      // every active call (not just this connection) by agentId instead.
      const alreadyOnACall = [...calls.values()].some((c) => c.agentId === agentId && c.answeredAt);
      if (alreadyOnACall) {
        conn.send({ type: 'answer-failed', callId, reason: 'already-on-a-call' });
        return;
      }
      removeFromQueue(callId);
      call.agentConn = conn;
      call.agentId = agentId;
      call.agentName = agentName;
      call.answeredAt = Date.now();
      conn.send({
        type: 'call-assigned',
        callId,
        topic: call.topic,
        kioskId: call.kioskId,
        queuedAt: call.queuedAt,
        language: call.language,
        languageLabel: languageLabel(call.language),
        transferredFrom: call.transferredFrom || null,
        transferNote: call.transferNote || null,
      });
      if (call.guestConn && call.guestConn.alive) {
        call.guestConn.send({ type: 'call-accepted', agentName });
      }
      broadcastQueue();
      return;
    }

    if (msg.type === 'transfer-call' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn) {
        transferCall(msg.callId, {
          note: String(msg.note || '').trim().slice(0, 500),
          language: msg.language,
          fromAgentName: agentName,
        });
      }
      return;
    }

    if (msg.type === 'signal' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn && call.guestConn && call.guestConn.alive) {
        call.guestConn.send({ type: 'signal', signalType: msg.signalType, data: msg.data });
      }
      return;
    }

    if (msg.type === 'hold-call' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn) beginHold(msg.callId);
      return;
    }

    if (msg.type === 'resume-call' && msg.callId) {
      const call = calls.get(msg.callId);
      if (call && call.agentConn === conn) resumeHold(msg.callId, 'manual');
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
      const entries = await Promise.all(
        callLog.slice(-50).reverse().map(async (e) => ({ ...e, recording: await recordingForCall(e.callId), rating: ratingForCall(e.callId) }))
      );
      conn.send({ type: 'call-log', entries });
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
  if (urlObj.pathname === '/api/call-config' && req.method === 'GET') {
    handleCallConfig(req, res);
    return;
  }
  if (urlObj.pathname === '/api/agent/request-password-reset' && req.method === 'POST') {
    handlePasswordResetRequest(req, res).catch((err) => {
      console.error('[password-reset] unhandled error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/api/recordings/chunk' && req.method === 'POST') {
    handleRecordingChunk(req, res, urlObj).catch((err) => {
      console.error('[recordings] chunk upload error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/api/recordings/finish' && req.method === 'POST') {
    handleRecordingFinish(req, res).catch((err) => {
      console.error('[recordings] finish error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  if (urlObj.pathname === '/api/ratings' && req.method === 'POST') {
    handleSubmitRating(req, res).catch((err) => {
      console.error('[ratings] unhandled error:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  const recordingFileMatch = urlObj.pathname.match(/^\/api\/recordings\/file\/([^/]+)$/);
  if (recordingFileMatch && req.method === 'GET') {
    handleRecordingFile(req, res, recordingFileMatch[1]);
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

// Keepalive pings so a proxy in front of this server (Render's included)
// doesn't treat a quiet-but-live connection as idle and close it out from
// under an in-progress call — AND, just as importantly, so dead connections
// (network drop, closed laptop lid, wifi that silently stopped routing)
// actually get detected and cleaned up.
//
// Sending pings alone doesn't do that second part: a plain TCP write into a
// socket whose other end has vanished without a clean FIN/RST doesn't error
// out on its own — the OS won't give up on it until its own retransmission
// timeout, which defaults to many minutes (sometimes much longer). Until
// then this connection would just sit in agentConns looking perfectly
// "alive", silently swallowing every queue-update (and the ring that comes
// with it) sent its way — this is what made a signed-in agent stop hearing
// new calls after their laptop slept or their network dropped for a while,
// with nothing but a missed heartbeat to tell.
//
// So this tracks the standard ping/pong liveness pattern instead: each
// connection is expected to answer the PREVIOUS ping (heartbeatOk, set by
// the pong handler in _handleFrame) before the next one goes out. Miss one
// full cycle and it's terminated outright — same cleanup a real close would
// trigger (onClose(), which drops it from agentConns/allConns and ends any
// call it was on) — rather than waiting on the OS to eventually notice.
setInterval(() => {
  for (const c of allConns) {
    if (!c.heartbeatOk) {
      console.log('[keepalive] connection missed a heartbeat — terminating as dead');
      c.terminate();
      continue;
    }
    c.heartbeatOk = false;
    c.ping();
  }
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
  KIOSKS = await store.loadKiosks(KIOSKS);
  ADMIN_PASSWORD = await store.loadAdminPassword(ADMIN_PASSWORD);
  CONFIG = await store.loadConfig(CONFIG);
  callLog.push(...await store.loadCallLog());
  missedCallLog.push(...await store.loadMissedCallLog());
  for (const c of await store.loadChats()) chatConversations.set(c.id, c);
  for (const r of await store.loadRatings()) ratings.set(r.callId, r);

  if (turn.configured) {
    console.log('[turn] Cloudflare TURN configured — calls will use it to connect across networks that block direct peer-to-peer.');
  } else {
    console.log('[turn] CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN not set — calls fall back to STUN-only, which cannot relay across networks that block direct connections (see README\'s "Video call relay" section).');
  }

  if (r2.configured) {
    console.log('[recordings] Cloudflare R2 configured — call recordings will be uploaded there and persist across restarts/redeploys.');
  } else {
    console.log('[recordings] R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET not set — recordings stay on local disk only, which most Render plans wipe on redeploy/restart (see README\'s "Call recordings" section).');
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
    console.log(`  Loaded ${AGENTS.length} agent(s), ${KIOSKS.length} kiosk account(s), ${callLog.length} call history entr${callLog.length === 1 ? 'y' : 'ies'}, ${chatConversations.size} chat conversation(s).`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
