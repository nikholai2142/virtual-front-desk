'use strict';
/**
 * Persistence layer for agents + call history.
 *
 * Backed by Upstash Redis's REST API — no npm package needed, just `fetch`,
 * which Node 18+ has built in, so this keeps the project's zero-dependency
 * approach. Configure it by setting two environment variables (Render →
 * your service → Environment tab):
 *
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * (Both come straight from your Upstash database's dashboard — see the
 * README's "Persistent storage" section.)
 *
 * Without them, the app still runs — it just falls back to the old
 * behavior (agents.json on disk, call history capped and in-memory-only)
 * so local development never requires an Upstash account. Every function
 * here is safe to call either way, and never throws: a Redis problem is
 * logged and degrades to "this change may not survive a restart," not a
 * crash.
 */

const REST_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const configured = Boolean(REST_URL && REST_TOKEN);

const AGENTS_KEY = 'vfd:agents';
const KIOSKS_KEY = 'vfd:kiosks';
const KIOSK_GROUPS_KEY = 'vfd:kioskgroups';
const ADMIN_PASSWORD_KEY = 'vfd:admin:password';
const CALL_LOG_KEY = 'vfd:calllog';
// A safety net, not a real limit — this is roughly 135 years of calls at
// one a day. It exists only so a bug or abuse can't grow the list forever.
const CALL_LOG_SAFETY_CAP = 50000;
// A guest who called in but was never answered (gave up waiting, or lost
// their connection before an agent picked up) — tracked separately from
// CALL_LOG_KEY rather than mixed into it, since those entries have no
// agent/answeredAt and would corrupt the duration/per-agent math that
// assumes every call log entry was actually answered.
const MISSED_CALL_LOG_KEY = 'vfd:missedcalls';
const MISSED_CALL_LOG_SAFETY_CAP = 50000;

// Updated by every Redis call; lets the admin dashboard show whether
// persistence is actually working right now, not just whether it's set up.
let connected = false;

async function redisCommand(args) {
  if (!configured) throw new Error('Upstash Redis is not configured (missing env vars)');
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error((body && body.error) || `Upstash request failed (HTTP ${res.status})`);
  }
  return body.result;
}

/** Pings Redis so callers can log a clear "connected" / "not reachable" line at startup. */
async function checkConnection() {
  if (!configured) {
    connected = false;
    return false;
  }
  try {
    await redisCommand(['PING']);
    connected = true;
  } catch (err) {
    connected = false;
    console.error('[store] Upstash Redis is configured but not reachable:', err.message);
  }
  return connected;
}

function getStatus() {
  return { configured, connected };
}

// ---- Agents --------------------------------------------------------------

/**
 * Loads the agent list from Redis. On a brand-new Redis database (first
 * deploy) there's nothing there yet, so it seeds Redis from `fallbackAgents`
 * (the local agents.json) and returns that. If Redis isn't configured or
 * isn't reachable, just returns `fallbackAgents` unchanged.
 */
async function loadAgents(fallbackAgents) {
  if (!configured) return fallbackAgents;
  try {
    const raw = await redisCommand(['GET', AGENTS_KEY]);
    connected = true;
    if (raw) return JSON.parse(raw);
    await redisCommand(['SET', AGENTS_KEY, JSON.stringify(fallbackAgents)]);
    return fallbackAgents;
  } catch (err) {
    connected = false;
    console.error('[store] could not load agents from Redis, starting from the local file instead:', err.message);
    return fallbackAgents;
  }
}

/** Returns true if the agent list was actually saved to Redis, false otherwise (including "not configured"). */
async function persistAgents(agents) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', AGENTS_KEY, JSON.stringify(agents)]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save the agent list to Redis — this change may be lost on the next restart/redeploy:', err.message);
    return false;
  }
}

// ---- Kiosk accounts --------------------------------------------------------
// Same idea as the agent list above: Redis is the durable copy when
// configured, a local kiosks.json is the seed/fallback otherwise. Each kiosk
// device signs in with one of these (name + password) so only one device at
// a time can be signed in as a given kiosk — see server.js's kioskSessions.

/**
 * Loads the kiosk account list from Redis. On a brand-new Redis database
 * (first deploy) there's nothing there yet, so it seeds Redis from
 * `fallbackKiosks` (the local kiosks.json) and returns that. If Redis isn't
 * configured or isn't reachable, just returns `fallbackKiosks` unchanged.
 */
async function loadKiosks(fallbackKiosks) {
  if (!configured) return fallbackKiosks;
  try {
    const raw = await redisCommand(['GET', KIOSKS_KEY]);
    connected = true;
    if (raw) return JSON.parse(raw);
    await redisCommand(['SET', KIOSKS_KEY, JSON.stringify(fallbackKiosks)]);
    return fallbackKiosks;
  } catch (err) {
    connected = false;
    console.error('[store] could not load kiosk accounts from Redis, starting from the local file instead:', err.message);
    return fallbackKiosks;
  }
}

/** Returns true if the kiosk account list was actually saved to Redis, false otherwise (including "not configured"). */
async function persistKiosks(kiosks) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', KIOSKS_KEY, JSON.stringify(kiosks)]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save the kiosk account list to Redis — this change may be lost on the next restart/redeploy:', err.message);
    return false;
  }
}

// ---- Kiosk groups ----------------------------------------------------------
// Each kiosk account can belong to one group (server.js's KIOSK_GROUPS),
// which is where branding (accent color, logo, background photo) actually
// lives now — see the admin dashboard's Kiosk Groups panel. Same
// seed/fallback/Redis pattern as agents/kiosks above.

/**
 * Loads the kiosk group list from Redis. On a brand-new Redis database
 * (first deploy) there's nothing there yet, so it seeds Redis from
 * `fallbackGroups` (the local kiosk-groups.json) and returns that. If Redis
 * isn't configured or isn't reachable, just returns `fallbackGroups`
 * unchanged.
 */
async function loadKioskGroups(fallbackGroups) {
  if (!configured) return fallbackGroups;
  try {
    const raw = await redisCommand(['GET', KIOSK_GROUPS_KEY]);
    connected = true;
    if (raw) return JSON.parse(raw);
    await redisCommand(['SET', KIOSK_GROUPS_KEY, JSON.stringify(fallbackGroups)]);
    return fallbackGroups;
  } catch (err) {
    connected = false;
    console.error('[store] could not load kiosk groups from Redis, starting from the local file instead:', err.message);
    return fallbackGroups;
  }
}

/** Returns true if the kiosk group list was actually saved to Redis, false otherwise (including "not configured"). */
async function persistKioskGroups(groups) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', KIOSK_GROUPS_KEY, JSON.stringify(groups)]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save the kiosk group list to Redis — this change may be lost on the next restart/redeploy:', err.message);
    return false;
  }
}

// ---- Admin password --------------------------------------------------------
// Same idea as the agent list: Redis is the durable copy when configured, a
// local admin.json is the seed/fallback otherwise. Stored as a plain string
// (not JSON) since that's all it is.

/**
 * Loads the admin password from Redis. On a brand-new Redis database there's
 * nothing there yet, so it seeds Redis from `fallbackPassword` (the local
 * admin.json / default) and returns that. If Redis isn't configured or isn't
 * reachable, just returns `fallbackPassword` unchanged.
 */
async function loadAdminPassword(fallbackPassword) {
  if (!configured) return fallbackPassword;
  try {
    const raw = await redisCommand(['GET', ADMIN_PASSWORD_KEY]);
    connected = true;
    if (raw) return raw;
    await redisCommand(['SET', ADMIN_PASSWORD_KEY, fallbackPassword]);
    return fallbackPassword;
  } catch (err) {
    connected = false;
    console.error('[store] could not load the admin password from Redis, using the local fallback instead:', err.message);
    return fallbackPassword;
  }
}

/** Returns true if the new admin password was actually saved to Redis, false otherwise (including "not configured"). */
async function persistAdminPassword(password) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', ADMIN_PASSWORD_KEY, password]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save the admin password to Redis — this change may be lost on the next restart/redeploy:', err.message);
    return false;
  }
}

// ---- Call history ----------------------------------------------------------

/** Loads the full call history from Redis. Returns [] if not configured/unreachable. */
async function loadCallLog() {
  if (!configured) return [];
  try {
    const raw = await redisCommand(['LRANGE', CALL_LOG_KEY, '0', '-1']);
    connected = true;
    return (raw || [])
      .map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    connected = false;
    console.error('[store] could not load call history from Redis, starting empty:', err.message);
    return [];
  }
}

/** Appends one completed call to the persisted history. Returns true if it was actually saved. */
async function appendCallLogEntry(entry) {
  if (!configured) return false;
  try {
    await redisCommand(['RPUSH', CALL_LOG_KEY, JSON.stringify(entry)]);
    await redisCommand(['LTRIM', CALL_LOG_KEY, String(-CALL_LOG_SAFETY_CAP), '-1']);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save a call log entry to Redis — it will only exist in memory until the next restart:', err.message);
    return false;
  }
}

/** Loads every persisted "never answered" call. Returns [] if not configured/unreachable — same convention as loadCallLog. */
async function loadMissedCallLog() {
  if (!configured) return [];
  try {
    const raw = await redisCommand(['LRANGE', MISSED_CALL_LOG_KEY, '0', '-1']);
    connected = true;
    return (raw || [])
      .map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    connected = false;
    console.error('[store] could not load missed-call history from Redis, starting empty:', err.message);
    return [];
  }
}

/** Appends one never-answered call to the persisted history. Returns true if it was actually saved. */
async function appendMissedCallEntry(entry) {
  if (!configured) return false;
  try {
    await redisCommand(['RPUSH', MISSED_CALL_LOG_KEY, JSON.stringify(entry)]);
    await redisCommand(['LTRIM', MISSED_CALL_LOG_KEY, String(-MISSED_CALL_LOG_SAFETY_CAP), '-1']);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save a missed-call entry to Redis — it will only exist in memory until the next restart:', err.message);
    return false;
  }
}

// ---- Chat conversations (WhatsApp / Messenger) ----------------------------
// Each conversation is its own key, plus a set of conversation ids so we
// can list them all — this avoids relying on Redis's HGETALL response
// shape, which varies enough across REST wrappers that GET/SET/SADD/
// SMEMBERS (already used above, and already proven to work) is the safer
// bet here.

const CHAT_IDS_KEY = 'vfd:chat:ids';
function chatKey(id) {
  return `vfd:chat:${id}`;
}

/** Loads every persisted chat conversation. Returns [] if not configured/unreachable. */
async function loadChats() {
  if (!configured) return [];
  try {
    const ids = await redisCommand(['SMEMBERS', CHAT_IDS_KEY]);
    connected = true;
    if (!ids || !ids.length) return [];
    const conversations = [];
    for (const id of ids) {
      try {
        const raw = await redisCommand(['GET', chatKey(id)]);
        if (raw) conversations.push(JSON.parse(raw));
      } catch (err) {
        console.error(`[store] could not load chat conversation ${id}, skipping it:`, err.message);
      }
    }
    return conversations;
  } catch (err) {
    connected = false;
    console.error('[store] could not load chat conversations from Redis, starting empty:', err.message);
    return [];
  }
}

/** Saves one conversation (its full message history). Returns true if it actually reached Redis. */
async function persistChat(conversation) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', chatKey(conversation.id), JSON.stringify(conversation)]);
    await redisCommand(['SADD', CHAT_IDS_KEY, conversation.id]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save a chat conversation to Redis — it may be lost on the next restart:', err.message);
    return false;
  }
}

// ---- App config (video call configuration, etc.) --------------------------
// Same seed/fallback pattern as the admin password: a single JSON blob,
// Redis is the durable copy when configured, a local config.json is the
// seed/fallback otherwise.

const CONFIG_KEY = 'vfd:config';

/**
 * Loads the app config from Redis. On a brand-new Redis database there's
 * nothing there yet, so it seeds Redis from `fallbackConfig` (the local
 * config.json / defaults) and returns that. If Redis isn't configured or
 * isn't reachable, just returns `fallbackConfig` unchanged.
 */
async function loadConfig(fallbackConfig) {
  if (!configured) return fallbackConfig;
  try {
    const raw = await redisCommand(['GET', CONFIG_KEY]);
    connected = true;
    if (raw) return { ...fallbackConfig, ...JSON.parse(raw) };
    await redisCommand(['SET', CONFIG_KEY, JSON.stringify(fallbackConfig)]);
    return fallbackConfig;
  } catch (err) {
    connected = false;
    console.error('[store] could not load app config from Redis, using the local fallback instead:', err.message);
    return fallbackConfig;
  }
}

/** Returns true if the config was actually saved to Redis, false otherwise (including "not configured"). */
async function persistConfig(config) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', CONFIG_KEY, JSON.stringify(config)]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save app config to Redis — this change may be lost on the next restart/redeploy:', err.message);
    return false;
  }
}

// ---- Call ratings (post-call guest feedback) -------------------------------
// Same shape as chat conversations above: one key per rating plus a set of
// ids, rather than a single hash — see the comment on loadChats() for why
// (HGETALL's response shape varies too much across REST wrappers to rely on).

const RATING_IDS_KEY = 'vfd:rating:ids';
function ratingKey(callId) {
  return `vfd:rating:${callId}`;
}

/** Loads every persisted call rating. Returns [] if not configured/unreachable. */
async function loadRatings() {
  if (!configured) return [];
  try {
    const ids = await redisCommand(['SMEMBERS', RATING_IDS_KEY]);
    connected = true;
    if (!ids || !ids.length) return [];
    const ratings = [];
    for (const id of ids) {
      try {
        const raw = await redisCommand(['GET', ratingKey(id)]);
        if (raw) ratings.push(JSON.parse(raw));
      } catch (err) {
        console.error(`[store] could not load rating for call ${id}, skipping it:`, err.message);
      }
    }
    return ratings;
  } catch (err) {
    connected = false;
    console.error('[store] could not load call ratings from Redis, starting empty:', err.message);
    return [];
  }
}

/** Saves one call's rating. Returns true if it actually reached Redis. */
async function persistRating(rating) {
  if (!configured) return false;
  try {
    await redisCommand(['SET', ratingKey(rating.callId), JSON.stringify(rating)]);
    await redisCommand(['SADD', RATING_IDS_KEY, String(rating.callId)]);
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    console.error('[store] could not save a call rating to Redis — it may be lost on the next restart:', err.message);
    return false;
  }
}

/**
 * Read-only counts of what clearTestData() would delete — lets the cleanup
 * script show real numbers on a dry run without touching anything.
 */
async function peekTestData() {
  const counts = { callLog: 0, missedCalls: 0, chats: 0, ratings: 0 };
  if (!configured) return { ...counts, configured: false };
  try {
    counts.callLog = (await redisCommand(['LLEN', CALL_LOG_KEY])) || 0;
    counts.missedCalls = (await redisCommand(['LLEN', MISSED_CALL_LOG_KEY])) || 0;
    counts.chats = ((await redisCommand(['SMEMBERS', CHAT_IDS_KEY])) || []).length;
    counts.ratings = ((await redisCommand(['SMEMBERS', RATING_IDS_KEY])) || []).length;
    connected = true;
    return { ...counts, configured: true };
  } catch (err) {
    connected = false;
    console.error('[store] could not read test-data counts from Redis:', err.message);
    return { ...counts, configured: true, error: err.message };
  }
}

// ---- Test-data cleanup (go-live prep) --------------------------------------
// Deletes everything a guest/agent generated during testing — call history,
// missed calls, chat conversations, ratings — while leaving the agent
// roster, admin password, and app config (max hold time, enabled languages)
// untouched, since those are real setup you want to keep. Recordings live in
// R2/local disk, not Redis, so this doesn't touch them — see
// clear-test-data.js, which calls this alongside the recordings cleanup.
// Returns how many of each it found, whether or not it actually deleted
// them (configured: false / not reachable still reports accurate counts as
// zero, same "never throws" convention as the rest of this file).
async function clearTestData() {
  const counts = { callLog: 0, missedCalls: 0, chats: 0, ratings: 0 };
  if (!configured) return { ...counts, configured: false };
  try {
    counts.callLog = (await redisCommand(['LLEN', CALL_LOG_KEY])) || 0;
    counts.missedCalls = (await redisCommand(['LLEN', MISSED_CALL_LOG_KEY])) || 0;
    const chatIds = (await redisCommand(['SMEMBERS', CHAT_IDS_KEY])) || [];
    const ratingIds = (await redisCommand(['SMEMBERS', RATING_IDS_KEY])) || [];
    counts.chats = chatIds.length;
    counts.ratings = ratingIds.length;

    await redisCommand(['DEL', CALL_LOG_KEY]);
    await redisCommand(['DEL', MISSED_CALL_LOG_KEY]);
    for (const id of chatIds) await redisCommand(['DEL', chatKey(id)]);
    await redisCommand(['DEL', CHAT_IDS_KEY]);
    for (const id of ratingIds) await redisCommand(['DEL', ratingKey(id)]);
    await redisCommand(['DEL', RATING_IDS_KEY]);

    connected = true;
    return { ...counts, configured: true };
  } catch (err) {
    connected = false;
    console.error('[store] could not clear test data from Redis:', err.message);
    return { ...counts, configured: true, error: err.message };
  }
}

module.exports = {
  configured,
  checkConnection,
  getStatus,
  peekTestData,
  clearTestData,
  loadAgents,
  persistAgents,
  loadKiosks,
  persistKiosks,
  loadKioskGroups,
  persistKioskGroups,
  loadAdminPassword,
  persistAdminPassword,
  loadCallLog,
  appendCallLogEntry,
  loadMissedCallLog,
  appendMissedCallEntry,
  loadChats,
  persistChat,
  loadConfig,
  persistConfig,
  loadRatings,
  persistRating,
};
