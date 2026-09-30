#!/usr/bin/env node
'use strict';
/**
 * One-time cleanup before going live: wipes everything a test call/guest/
 * agent generated while you were trying the app out — call history, missed
 * calls, chat conversations (WhatsApp/Messenger), ratings, and recordings.
 *
 * Deliberately leaves alone: your agent roster, the admin password, and app
 * config (max hold time, enabled languages) — those are real setup, not
 * test data, so this never touches them.
 *
 * Run it with the SAME environment variables your deployed service uses
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, and the R2_* vars if
 * you're using R2 for recordings) — either locally with a `.env` loaded into
 * your shell, or from Render's Shell tab on the service itself, where those
 * vars are already set. See the README's "Environment variables" section
 * for where each one comes from.
 *
 * Usage:
 *   node clear-test-data.js            # dry run — shows what's there, deletes nothing
 *   node clear-test-data.js --yes      # actually deletes it
 *
 * This only clears what's *persisted* (Redis + R2/local disk). If your
 * service is also running right now, it's holding its own in-memory copy of
 * this same data (that's normal — see the README's "Persistent storage"
 * section) and will keep serving it until it restarts. So: run this, then
 * restart/redeploy the service, in that order — the fresh start will load
 * from the now-empty store instead of its old in-memory copy.
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const r2 = require('./r2');

const DRY_RUN = !process.argv.includes('--yes');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const RECORDINGS_INDEX_FILE = path.join(RECORDINGS_DIR, 'index.json');

function localRecordingFiles() {
  try {
    return fs.readdirSync(RECORDINGS_DIR).filter((name) => name !== 'index.json');
  } catch {
    return [];
  }
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — nothing will be deleted (pass --yes to actually clear it)\n' : 'Clearing test data...\n');

  // ---- Redis: call history, missed calls, chats, ratings ------------------
  const redisStatus = store.getStatus();
  if (!redisStatus.configured) {
    console.log('Upstash Redis: not configured — call history/chats/ratings are in-memory only on the running service; restarting it clears them.');
  } else if (DRY_RUN) {
    const counts = await store.peekTestData();
    if (counts.error) {
      console.log(`Upstash Redis: FAILED to read counts — ${counts.error}`);
    } else {
      console.log(
        `Upstash Redis: would delete ${counts.callLog} call log entr${counts.callLog === 1 ? 'y' : 'ies'}, ` +
          `${counts.missedCalls} missed call${counts.missedCalls === 1 ? '' : 's'}, ` +
          `${counts.chats} chat conversation${counts.chats === 1 ? '' : 's'}, ` +
          `${counts.ratings} rating${counts.ratings === 1 ? '' : 's'}.`
      );
    }
  } else {
    const result = await store.clearTestData();
    if (result.error) {
      console.log(`Upstash Redis: FAILED — ${result.error}`);
    } else {
      console.log(
        `Upstash Redis: deleted ${result.callLog} call log entr${result.callLog === 1 ? 'y' : 'ies'}, ` +
          `${result.missedCalls} missed call${result.missedCalls === 1 ? '' : 's'}, ` +
          `${result.chats} chat conversation${result.chats === 1 ? '' : 's'}, ` +
          `${result.ratings} rating${result.ratings === 1 ? '' : 's'}.`
      );
    }
  }

  // ---- R2: recordings -------------------------------------------------------
  if (!r2.configured) {
    console.log('Cloudflare R2: not configured — recordings (if any) are on local disk, handled below.');
  } else {
    try {
      const keys = await r2.listObjectKeys();
      if (DRY_RUN) {
        console.log(`Cloudflare R2: ${keys.length} recording object(s) would be deleted.`);
      } else {
        for (const key of keys) await r2.deleteObject(key);
        console.log(`Cloudflare R2: deleted ${keys.length} recording object(s).`);
      }
    } catch (err) {
      console.log(`Cloudflare R2: FAILED to list/delete objects — ${err.message}`);
    }
  }

  // ---- Local disk: recordings/ (used when R2 isn't configured, or as a
  // leftover from before it was wired up) -------------------------------
  const localFiles = localRecordingFiles();
  if (DRY_RUN) {
    console.log(`Local disk: ${localFiles.length} recording file(s) in recordings/ would be deleted, and recordings/index.json would be reset.`);
  } else {
    for (const name of localFiles) {
      try {
        fs.unlinkSync(path.join(RECORDINGS_DIR, name));
      } catch (err) {
        console.log(`  could not delete recordings/${name}: ${err.message}`);
      }
    }
    try {
      fs.writeFileSync(RECORDINGS_INDEX_FILE, '[]');
    } catch (err) {
      console.log(`  could not reset recordings/index.json: ${err.message}`);
    }
    console.log(`Local disk: deleted ${localFiles.length} recording file(s), reset recordings/index.json.`);
  }

  console.log(
    DRY_RUN
      ? '\nNothing was deleted. Re-run with --yes to actually clear it, then restart/redeploy the service.'
      : '\nDone. Now restart/redeploy the service so it starts from this empty state instead of its in-memory copy.'
  );
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
