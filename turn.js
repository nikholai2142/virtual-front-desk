'use strict';
/**
 * Mints short-lived WebRTC TURN credentials from Cloudflare's Realtime TURN
 * service. No npm package needed — just `fetch`.
 *
 * Unlike a typical TURN provider (Metered.ca, Twilio), Cloudflare's own
 * docs are explicit that the API token must stay server-side and never
 * reach the browser — so this issues short-lived, scoped credentials on
 * request instead of handing out one static secret to every client. That's
 * why this needs a server endpoint (see server.js's /api/turn-credentials)
 * rather than just a client-side ICE_SERVERS array.
 *
 * Env vars (Render → your service → Environment):
 *   CLOUDFLARE_TURN_KEY_ID     - from the Cloudflare dashboard (Realtime > TURN)
 *   CLOUDFLARE_TURN_API_TOKEN  - the API token generated alongside it
 *
 * See the README's "Video call relay (TURN)" section for the full setup.
 */

// Comfortably longer than any realistic single call, well under
// Cloudflare's 48-hour maximum — minted fresh for every new call rather
// than reused, so there's no need to push this any higher.
const CREDENTIAL_TTL_SECONDS = 4 * 60 * 60; // 4 hours

const TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || '';
const TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || '';
const configured = Boolean(TURN_KEY_ID && TURN_API_TOKEN);

// A free, keyless fallback so calls can still at least attempt a direct
// peer-to-peer connection (no relay) if Cloudflare isn't configured, or if
// a request to mint credentials fails. This won't help on networks that
// need a TURN relay to connect at all, but it's better than nothing.
const STUN_ONLY_FALLBACK = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

async function generateIceServers() {
  if (!configured) throw new Error('Cloudflare TURN is not configured on this server (missing env vars)');
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    }
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.iceServers) {
    throw new Error((body && body.error) || `Cloudflare TURN request failed (HTTP ${res.status})`);
  }
  return body.iceServers;
}

module.exports = {
  configured,
  generateIceServers,
  STUN_ONLY_FALLBACK,
};
