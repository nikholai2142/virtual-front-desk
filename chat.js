'use strict';
/**
 * WhatsApp + Facebook Messenger integration, talking directly to Meta's
 * Graph API — no npm packages needed (just `fetch` and the built-in
 * `crypto` module for verifying webhook signatures).
 *
 * Each channel is independently optional: set only the env vars for the
 * one(s) you want (Render → your service → Environment). The other stays
 * inactive rather than breaking anything.
 *
 *   WHATSAPP_ACCESS_TOKEN       - WhatsApp > API Setup in your Meta app
 *   WHATSAPP_PHONE_NUMBER_ID    - same page, "Phone number ID" (NOT the phone number itself)
 *   MESSENGER_PAGE_ACCESS_TOKEN - Messenger > Settings > Access Tokens in your Meta app
 *   META_APP_SECRET             - your Meta app's App Secret (Settings > Basic) — verifies
 *                                  that incoming webhooks really came from Meta
 *   META_WEBHOOK_VERIFY_TOKEN   - a string you make up yourself, used once when you save
 *                                  the webhook URL in the Meta app dashboard
 *
 * See the README's "WhatsApp & Facebook chat" section for the full,
 * step-by-step Meta Developer App setup — creating the account is the
 * long pole here, not this code.
 */

const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const MESSENGER_PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';

const whatsappConfigured = Boolean(WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
const messengerConfigured = Boolean(MESSENGER_PAGE_ACCESS_TOKEN);
// Both channels' webhooks share one app, so one secret/token pair covers both.
const webhooksConfigured = Boolean(APP_SECRET && VERIFY_TOKEN);

// ---- Sending ---------------------------------------------------------

async function sendWhatsAppMessage(toPhone, text) {
  if (!whatsappConfigured) throw new Error('WhatsApp is not configured on this server (missing env vars)');
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body: text },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Meta's most common failure here: the guest's 24-hour service window
    // has closed, so a free-form text reply is rejected and a pre-approved
    // template message is required instead. Surface whatever Meta says.
    throw new Error((body && body.error && body.error.message) || `WhatsApp send failed (HTTP ${res.status})`);
  }
  return body;
}

async function sendMessengerMessage(psid, text) {
  if (!messengerConfigured) throw new Error('Messenger is not configured on this server (missing env vars)');
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(MESSENGER_PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body && body.error && body.error.message) || `Messenger send failed (HTTP ${res.status})`);
  }
  return body;
}

// ---- Webhook verification ---------------------------------------------

/**
 * Meta sends one GET request when you save a webhook subscription, to
 * prove you control this URL. Returns the challenge string to echo back,
 * or null if the request doesn't check out.
 */
function verifyWebhookChallenge(query) {
  if (!VERIFY_TOKEN) return null;
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === VERIFY_TOKEN) {
    return query['hub.challenge'] || '';
  }
  return null;
}

/**
 * Verifies the X-Hub-Signature-256 header Meta sends on every webhook
 * POST, so a request claiming to be a WhatsApp/Messenger message can't be
 * spoofed by someone who just finds your webhook URL. `rawBody` must be
 * the exact, unparsed bytes Meta sent (signing is computed over the raw
 * body, not the re-serialized JSON).
 */
function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  const givenHex = signatureHeader.slice('sha256='.length);
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(givenHex, 'hex');
  if (expected.length !== given.length) return false; // mismatched length just means "no match"
  return crypto.timingSafeEqual(expected, given);
}

// ---- Webhook payload parsing --------------------------------------------
// Both return an array of { contactId, contactName, text, at } — usually
// 0 or 1 items, but Meta can batch several messages into one webhook call.
// Non-text events (delivery receipts, read receipts, postbacks, reactions,
// stickers/images without a caption) are silently skipped for now — this
// is a text-chat integration, not a full media inbox.

function parseWhatsAppWebhook(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactsByWaId = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
      for (const msg of value.messages || []) {
        if (msg.type !== 'text' || !msg.text) continue; // skip images/audio/status updates etc. for now
        out.push({
          contactId: msg.from,
          contactName: contactsByWaId.get(msg.from) || null,
          text: msg.text.body,
          at: Number(msg.timestamp) * 1000 || Date.now(),
        });
      }
    }
  }
  return out;
}

function parseMessengerWebhook(body) {
  const out = [];
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const event of entry.messaging || []) {
      // Skip echoes of our own sent messages, delivery/read receipts, and
      // postbacks — only handle an actual incoming text message.
      if (!event.message || event.message.is_echo || !event.message.text) continue;
      out.push({
        contactId: event.sender && event.sender.id,
        // Messenger's messaging webhook doesn't include the user's name,
        // and fetching it needs extra permissions this integration
        // doesn't request — the UI falls back to a short PSID label.
        contactName: null,
        text: event.message.text,
        at: Number(event.timestamp) || Date.now(),
      });
    }
  }
  return out.filter((m) => m.contactId);
}

module.exports = {
  whatsappConfigured,
  messengerConfigured,
  webhooksConfigured,
  sendWhatsAppMessage,
  sendMessengerMessage,
  verifyWebhookChallenge,
  verifySignature,
  parseWhatsAppWebhook,
  parseMessengerWebhook,
};
