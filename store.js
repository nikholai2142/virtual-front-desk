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
const CALL_LOG_KEY = 'vfd:calllog';
// A safety net, not a real limit — this is roughly 135 years of calls at
// one a day. It exists only so a bug or abuse can't grow the list forever.
const CALL_LOG_SAFETY_CAP = 50000;

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

module.exports = {
  configured,
  checkConnection,
  getStatus,
  loadAgents,
  persistAgents,
  loadCallLog,
  appendCallLogEntry,
  loadChats,
  persistChat,
};
