# Virtual Front Desk — Video Concierge Prototype

A working prototype that lets a hotel guest walk up to a lobby kiosk/tablet,
tap one button, and be connected by live video to a remote Front Desk agent —
without installing anything or downloading an app. Built for **multiple
kiosks** around the property — each one is named once (e.g. "Lobby", "Pool
Deck") so agents always know where a call is coming from.

Three screens, one server:

- **Kiosk** (`/`) — the guest-facing screen for a lobby tablet. Supports
  multiple physical kiosks — see "Multiple kiosks" below.
- **Agent Dashboard** (`/agent`) — where remote staff sign in, watch the
  queue, take calls, and (optionally) handle WhatsApp/Facebook Messenger
  chats from guests.
- **Admin Dashboard** (`/admin`) — where a manager adds/removes agents and
  checks each agent's call performance.

Zero npm dependencies. The signaling server is plain Node (built-in `http`
module, plus a small hand-rolled WebSocket implementation), and everything
that talks to an outside service — Upstash Redis for persistence, Meta's
Graph API for WhatsApp/Messenger — does it over plain HTTPS using the
`fetch` Node already has built in. No `npm install`, nothing to audit
beyond this repo.

## How it works

1. Guest taps "Start Video Call" on the kiosk → browser asks for camera/mic
   access → guest is added to a server-side queue for that call, tagged
   with which kiosk they called from.
2. Every signed-in agent's dashboard gets a live queue update over
   WebSocket and can claim the call ("Answer"). Only one agent can win a
   given call — the server settles ties.
3. Guest and agent browsers exchange a WebRTC offer/answer and ICE
   candidates, relayed through the server as small JSON messages over the
   same WebSocket. Once connected, video/audio flows **directly between
   the two browsers** (or through a TURN relay if needed) — it never
   touches the server.
4. Either side can end the call. The agent can leave notes, which are
   saved to a call log (topic, agent, duration, notes) shown in the
   dashboard sidebar and used for the admin dashboard's stats. This is
   kept in memory by default, or persisted permanently if you [set up
   Upstash Redis](#persistent-storage-agents--call-history) (below).
5. If a guest closes the tab, loses network, or an agent's browser drops
   mid-call, the server detects the disconnect and cleans up the queue /
   notifies the other side, so nothing gets stuck.

## Multiple kiosks

Every call now comes from "Front Desk" (the only department — see
"What changed" below), so with several kiosks around the property, the
kiosk's **name** is what tells agents apart, not a department. Each kiosk
names itself once:

- **First launch**: opening `/` on a kiosk that's never been set up shows a
  one-time "Set up this kiosk" screen — type a name (e.g. "Lobby", "Pool
  Deck", "Level 2 Elevator Bank") and save. That name is remembered on that
  device (`localStorage`) for every call afterwards, across restarts and
  browser refreshes.
- **Bookmarked URL** (handy when provisioning several tablets at once):
  open `/?kiosk=Lobby` (URL-encode spaces, e.g. `/?kiosk=Pool%20Deck`) and
  that name is saved automatically — no on-screen setup needed. Bookmark a
  different URL per device.
- **Renaming a kiosk** (e.g. it's physically moved): tap the small "change"
  link at the bottom of the kiosk's idle screen to reopen the naming
  screen.

The kiosk's name travels with every call it starts — agents see it next to
each waiting call in the queue and in the active-call header (e.g. "Front
Desk · Pool Deck"), and it's included in the call log and the admin
dashboard's performance stats (which now show each agent's busiest kiosk
instead of a department, since there's only one department left).

```
 ┌─────────────┐   WebSocket (signaling only)   ┌──────────────────┐
 │ Kiosk tablet │ ─────────────────────────────► │  Node server      │
 │  (guest)     │ ◄───────────────────────────── │  - call queue     │
 └──────┬───────┘                                 │  - pairing        │
        │                                          │  - SDP/ICE relay  │
        │        WebRTC peer-to-peer video         └──────────┬────────┘
        └──────────────────────────────────────────────────────┘
                              ▲
                              │ WebSocket (signaling only)
                       ┌──────┴───────┐
                       │ Agent laptop │
                       └──────────────┘
```

## Running it

```bash
node server.js
# Guest kiosk:     http://localhost:3000/
# Agent dashboard: http://localhost:3000/agent
```

No build step, no install step. Requires Node 18+.

Demo agent passwords (edit `agents.json` to change, or add more agents):

| Password | Name |
|----------|------|
| alex1234 | Alex |
| sam5678  | Sam  |

Open `/agent` in one browser tab/device and `/` in another to try the
whole flow yourself.

## Video call relay (TURN)

WebRTC tries a direct connection between the two browsers first. On a lot
of real-world networks that fails silently — hotel guest wifi and many
home/office routers block direct peer-to-peer connections outright (a
feature usually called "client isolation") — and without a fallback, the
call just hangs with no video and no error. A **TURN server** is that
fallback: it relays the call's video/audio when a direct connection isn't
possible.

This project uses **Cloudflare's TURN service** (part of
[Cloudflare Realtime](https://developers.cloudflare.com/realtime/turn/)),
called from a small server endpoint (`/api/turn-credentials`) that
`kiosk.js` and `agent.js` fetch right before starting a call — Cloudflare's
own guidance is that TURN credentials shouldn't be hardcoded into
client-side code the way a lot of other TURN providers' are, since they're
meant to be short-lived and minted per use, so the server does that
minting on request. Its free tier is generous: **1,000 GB/month** of
relay traffic before any cost, then $0.05/GB — likely enough that a single
hotel never gets billed for this at all.

**Without it set up, calls fall back to STUN-only** — direct peer-to-peer
connections still work (e.g. two devices on an open network), but any
call that would need a relay just fails to connect, the same silent-hang
problem described above. Set this up before relying on this for real
guest traffic.

### Setup

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → sign up
   free if you don't have an account → **Realtime** (may be listed as
   **Calls**) → **TURN**.
2. Click **Create TURN App** (or **Create Key**). This gives you a
   **Turn Key ID** and an **API Token** — copy both.
3. In Render, your service → **Environment**, add:

   | Variable | Value |
   |---|---|
   | `CLOUDFLARE_TURN_KEY_ID` | the Turn Key ID from step 2 |
   | `CLOUDFLARE_TURN_API_TOKEN` | the API Token from step 2 |

4. Save, let Render redeploy, and upload `server.js` and `turn.js` (new
   file) to GitHub if you haven't already.
5. Open `/agent`, sign in, and check the Render logs for `[turn]
   Cloudflare TURN configured` at startup to confirm it's active.

No code changes needed beyond what's already in this update — the two
env vars are the only thing that turns it on.

## Admin dashboard

Open `/admin` and sign in with the admin password (default `letmein`,
stored in `admin.json` — **change it before real use**, the same way you'd
change the demo agent passwords).

From the dashboard you can:

- **Add an agent** — enter a name and a password (at least 4 characters,
  letters/numbers/symbols all fine); it's added to the agent list
  immediately (agents can sign in at `/agent` right away, no restart
  needed).
- **Remove an agent** — click "Remove" on any agent's row (asks for
  confirmation first).
- **Change the admin password** — click the ⚙ button next to "Refresh",
  enter the current password and a new one. Takes effect immediately (your
  own session keeps working without needing to sign in again).
- **Handle password reset requests** — see the "Password resets" section
  below.
- **Stay signed in across a page refresh** — both `/agent` and `/admin`
  remember your session (via the browser's `sessionStorage`) until you
  click **Sign out** or close the tab. Refreshing the page — or the
  browser reconnecting after a Render free-tier cold start — no longer
  drops you back to the sign-in screen.
- **See performance per agent** — calls handled, total and average talk
  time, most common call topic, and time of their last call. A summary
  line at the top shows how many agents are currently online, how many
  guests are waiting, and how many calls are active right now. The
  dashboard refreshes itself every 10 seconds, or click "Refresh" for an
  immediate update.

### Password resets

Agents can change their own password any time from the ⚙ button in the
`/agent` dashboard's top bar (current password + new password).

If an agent forgets their password, they click **"Forgot your password?"**
on the `/agent` sign-in screen and enter their name. That queues a request
that shows up in the admin dashboard's **"Password reset requests"** panel
— usually within 10 seconds, and it's badged in red so it's hard to miss.
From there you can either:

- Type a new password into the request's row and click **Set** — this
  updates that agent's password immediately (tell them the new password
  through whatever channel you trust), or
- Click **Dismiss** to clear the request without changing anything (e.g.
  it was a mistake, or you handled it another way).

If the name they typed doesn't match any agent on file (a typo, or an
agent that's since been removed), the request still shows up so you know
someone's locked out, but there's no "Set" option — only "Dismiss" — until
you add or rename the matching agent.

Password reset requests are **in-memory only** (like the live call queue),
not persisted to Redis — they're meant to be handled promptly, not kept as
history, so a restart clears any that are still pending.

**Whether any of this survives a restart or a redeploy depends on whether
you've set up persistent storage** — see the next section. Without it,
added/removed agents and the call history it's added to reset the next
time the server restarts (which on a free Render instance can happen
often — see "What's real vs. what's stubbed" below), and stats only cover
the last 200 calls since the last restart. The note under "Performance" on
the dashboard itself always tells you which mode you're in.

The admin API itself (`/api/admin/agents`, `/api/admin/stats`) is
protected by a single shared password sent as an `X-Admin-Password`
header — there's no per-admin login or audit trail, matching the same
demo-grade auth used for agent passwords. Treat it the same way: fine for a
small team getting started, swap for real auth (SSO, a proper user table)
before this is relied on operationally.

## Persistent storage (agents + call history)

By default, agents you add/remove through `/admin` and the call history
behind its performance stats live only in the running server's memory (and
a local `agents.json`, which itself resets on a host like Render — see
below). That's fine for trying things out, but not for actually relying on
it: a restart, a spin-down (free Render instances sleep after inactivity),
or your next deploy wipes it clean.

To make agents, the admin password, and call history **permanent —
surviving restarts and redeploys, with true all-time history** — connect a
free [Upstash](https://upstash.com) Redis database. It's a small cloud
database reached over plain HTTPS, so no extra npm packages are needed, and
it has a generous free tier that easily covers a single hotel's traffic.
(Password reset *requests* are the one exception — see "Password resets"
above — those stay in-memory even with Redis configured, by design.)

**1. Create a free Upstash account and database**

1. Go to [upstash.com](https://upstash.com) and sign up (email or GitHub
   — since you already have a GitHub account from the deploy steps above,
   that's the fastest option). No credit card needed for the free tier.
2. Once you're in the Upstash console, click **Create Database**.
3. Give it any name (e.g. `virtual-front-desk`), pick a region close to
   where your Render service runs (doesn't need to match exactly), and
   leave the other settings on their defaults. Click **Create**.

**2. Get your two credentials**

1. Open the database you just created.
2. Find the **REST API** section of its page (sometimes shown as a
   "Connect" or ".env" tab — look for `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`).
3. Copy both values — you'll paste them into Render next. Keep this tab
   open, or copy them somewhere safe for a moment.

**3. Add them to Render**

1. In the [Render dashboard](https://dashboard.render.com), open your
   `virtual-front-desk` web service.
2. Click **Environment** in the left sidebar.
3. Click **Add Environment Variable** and add:
   - Key: `UPSTASH_REDIS_REST_URL` — Value: (paste what you copied)
   - Key: `UPSTASH_REDIS_REST_TOKEN` — Value: (paste what you copied)
4. Click **Save Changes**. Render will automatically redeploy your
   service with these available.

**4. Upload the updated code**

If you haven't already, upload `server.js` and the new `store.js` file to
your GitHub repo (see "Running it" / your original deploy steps for how —
same web-upload flow). Once both the code and the environment variables
are in place and the service has redeployed, open `/admin` — the note
under "Performance" should say stats are persisted to Redis. From then on,
every agent you add/remove and every completed call is saved there
immediately, and will still be there after any restart or redeploy.

**If you skip this step**, the app still works exactly as before — it
just falls back to memory-only agents/history, and the admin dashboard's
note will say persistent storage isn't set up.

## WhatsApp & Facebook chat

Alongside video calls, agents can also handle **WhatsApp and Facebook
Messenger text chats** from a "Chats" tab in `/agent` — a guest messages
your hotel's WhatsApp number or Facebook Page, and it shows up live in the
dashboard for any signed-in agent to reply to, with the full conversation
saved (persisted to Redis if you've set that up above).

This talks directly to Meta's own APIs — no third-party service, no
monthly fee for the messaging itself. But it does mean creating a Meta
Developer App yourself, which is the longest part of this setup, and
**there's a hard limit you should know before you start**: until Meta
approves your app for these permissions (App Review + Business
Verification), you can only message/receive from a short list of test
accounts you add yourself — not real, random guests. Testing end-to-end
works immediately; going live for actual hotel guests needs that approval,
which can take Meta several days to a couple of weeks. Plan around that if
you're hoping to launch this by a specific date.

Each channel — WhatsApp, Messenger — is independent: set up just one if
that's all you need, and add the other later. Neither requires touching
the code again, only environment variables.

### 1. Create a Meta Developer App

1. Go to [developers.facebook.com](https://developers.facebook.com) and
   log in with the same Facebook account you used for Business Suite.
2. Click **My Apps** → **Create App**.
3. Choose the **Business** app type, give it a name (e.g. "Hotel Front
   Desk Chat"), and associate it with the Business Portfolio you created
   earlier (Meta will offer to link it).
4. On the app's dashboard, find **WhatsApp** and **Messenger** in the
   product list and click **Set Up** on each one you want.

### 2. Set up WhatsApp

1. Under **WhatsApp → API Setup**, Meta gives you a free test phone
   number and a temporary access token immediately — enough to try
   everything below without your own number. Add your own phone as a
   "recipient number" on that page so you can send yourself test
   messages.
2. Note the **Phone number ID** shown on that page (not the phone number
   itself) — that's `WHATSAPP_PHONE_NUMBER_ID`.
3. The temporary access token shown there works for 24 hours — fine for
   testing, not for a real deployment. For one that doesn't expire: go to
   [business.facebook.com/settings](https://business.facebook.com/settings)
   → **System Users** → create one → assign it to your WhatsApp Business
   Account → generate a token for it with the `whatsapp_business_messaging`
   permission and no expiration. That's `WHATSAPP_ACCESS_TOKEN`.
4. When you're ready to use your own hotel number instead of the test
   one: same **API Setup** page → **Add phone number** → verify it by SMS
   or voice call.

### 3. Set up Messenger

1. Under **Messenger → Settings → Access Tokens**, connect the Facebook
   Page you created for Business Suite.
2. Generate a **Page Access Token** — that's `MESSENGER_PAGE_ACCESS_TOKEN`.

### 4. Get your App Secret

In the app dashboard, go to **Settings → Basic**, click **Show** next to
**App Secret** (it'll ask you to re-enter your Facebook password). That's
`META_APP_SECRET` — it's what lets the server verify an incoming webhook
really came from Meta and not someone else who found your URL.

### 5. Configure the webhook

1. Still in the app dashboard, find **Webhooks** (in the sidebar, or under
   each product's own settings).
2. For WhatsApp: set the **Callback URL** to
   `https://<your-render-url>/webhooks/whatsapp`, and **Verify Token** to
   any string you make up yourself — that's `META_WEBHOOK_VERIFY_TOKEN`
   (you can reuse the same one for Messenger below). Click **Verify and
   Save**, then subscribe to the **messages** field.
3. For Messenger: same Callback URL pattern but
   `https://<your-render-url>/webhooks/messenger`, same verify token,
   subscribe to **messages**, and select the Facebook Page to receive
   messages for.

(Your server needs to already be deployed and running for "Verify and
Save" to succeed, since Meta calls that URL immediately to check it.)

### 6. Add the environment variables to Render

Same place as the Upstash variables earlier: your Render service →
**Environment** → add whichever of these apply to the channel(s) you set
up:

| Variable | Where it came from |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp system user token (step 2.3) |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp API Setup page (step 2.2) |
| `MESSENGER_PAGE_ACCESS_TOKEN` | Messenger access tokens page (step 3.2) |
| `META_APP_SECRET` | App Settings → Basic (step 4) |
| `META_WEBHOOK_VERIFY_TOKEN` | a string you invented yourself (step 5.2) |

Save, let Render redeploy, and upload `server.js`, `chat.js`, and the
changed `public/agent.*` files to GitHub if you haven't already.

### 7. Test it

Send a WhatsApp message from the phone number you added as a test
recipient, or message the Facebook Page from your own account — both
should appear in `/agent`'s Chats tab within a second or two, with an
unread badge and a notification sound. Reply from the dashboard and
confirm it arrives on your phone.

### Before this handles real guests

- **App Review + Business Verification.** Covered above — without it,
  only your manually-added test numbers (WhatsApp) and people with a role
  on your Page/app (Messenger) can talk to this. Submit for review from
  the app dashboard once you've tested everything works; Meta will ask
  for a short video showing the flow.
- **WhatsApp's 24-hour window.** You can only send a free-form text reply
  within 24 hours of the guest's last message. Outside that window,
  WhatsApp requires a pre-approved *template* message instead, which
  this integration doesn't send — a reply attempted outside the window
  will fail, and the dashboard shows Meta's error message when that
  happens. For a front desk that's usually fine (guests message and wait
  for a reply), but worth knowing if an agent tries to follow up on an
  old conversation.
- **Media messages aren't handled.** Photos, voice notes, and documents a
  guest sends are currently skipped — only text messages show up. Common
  guest questions (check-in time, wifi, directions) rarely need more than
  text, but if you need this, `chat.js`'s `parseWhatsAppWebhook` /
  `parseMessengerWebhook` is where to add it.
- **No contact profile photos**, and Messenger contacts show as "Messenger
  guest •1234" (the last 4 digits of their ID) since Messenger's
  messaging webhook doesn't include a name and fetching one needs
  additional permissions this integration doesn't request.

## What's real vs. what's stubbed (read before deploying)

This is a functioning prototype, not a hardened product. Before putting it
in a real lobby:

- **HTTPS is required.** Browsers only allow camera/mic access
  (`getUserMedia`) on `https://` or `localhost`. Put this behind a reverse
  proxy (Caddy, nginx, or a platform like Render/Fly.io) with a real
  certificate before it touches a guest-facing tablet.
- **TURN needs to be set up before going live.** See "Video call relay
  (TURN)" above — without `CLOUDFLARE_TURN_KEY_ID` /
  `CLOUDFLARE_TURN_API_TOKEN` configured, calls fall back to STUN-only and
  any guest on a network that blocks direct peer-to-peer connections
  (common on hotel guest wifi) will get a silent hang instead of a call.
- **Replace the agent login and the admin password.** `agents.json` and
  `admin.json` are flat files for the demo, and everyone (agents, the
  admin) can now change their own password from the dashboard, plus
  request a reset if they forget it — but it's still one shared password
  per role with no per-person accounts or audit trail. Swap
  `handleAgentConnection`'s password check and the admin API's password
  check in `server.js` for real auth (SSO, your PMS's staff directory,
  per-shift codes, etc.) before this is used with real guests or handed to
  real managers.
- **The live queue and active calls are in-memory, always.** Who's
  waiting and who's on a call right now lives in the Node process's
  memory regardless of the Redis setup above, so it can't run as multiple
  load-balanced instances as-is (a guest in the queue on instance A is
  invisible to instance B). Fine for a single lobby kiosk talking to a
  single running server, which is how Render's free/starter tiers work by
  default. Agents and call *history* are a separate concern — see
  "Persistent storage" above — and do survive restarts once Redis is
  connected.
- **No recording, transcripts, or PMS integration.** Calls are pure
  peer-to-peer video; the call log only stores topic, agent, duration and
  notes, nothing from the video/audio itself.
- **No multi-device ringing / overflow routing.** Any signed-in agent can
  answer any waiting call; there's no skill-based routing, no
  "ring all agents then escalate," and no SMS/callback fallback if no
  agent is available. The kiosk just tells the guest to dial 0 if the
  wait is long.
- **Kiosk has no idle/attract screen or accessibility pass.** It's built
  for a touchscreen but hasn't been tested with a screen reader, and there's
  no auto-lock/timeout if a guest walks away mid-flow beyond the call
  itself ending.

## Project layout

```
virtual-front-desk/
├── server.js       Signaling server: WS relay, queue, agent auth, admin API, webhooks, static hosting
├── store.js        Persistence layer: Upstash Redis if configured, else local-only fallback
├── chat.js         WhatsApp/Messenger: Graph API sending, webhook signature check + parsing
├── turn.js         Cloudflare TURN: mints short-lived WebRTC relay credentials per call
├── agents.json     Seed/fallback agent passwords/names — real source of truth is Redis once configured
├── admin.json      Admin dashboard password (default "letmein" — change this)
├── package.json
└── public/
    ├── kiosk.html / kiosk.css / kiosk.js   Guest-facing lobby screen
    ├── agent.html / agent.css / agent.js   Agent dashboard (calls + WhatsApp/Messenger chats)
    └── admin.html / admin.css / admin.js   Admin dashboard (add/remove agents, view stats)
```

## Customizing

- **Departments**: the kiosk currently only offers "Front Desk" — to bring
  back other departments (Concierge, Housekeeping, etc.), add more buttons
  with a `data-topic` attribute back into `public/kiosk.html`'s idle
  screen (each needs its own click listener like `btn-start-call`'s in
  `kiosk.js`).
- **Branding**: colors are CSS custom properties at the top of
  `kiosk.css` / `agent.css` (`--bg`, `--accent`, etc.); swap the 🛎️ emoji
  for a logo image.
- **Wait-time warning**: `WAIT_WARNING_MS` in `kiosk.js` (default 60s)
  controls when the kiosk shows the "still connecting… dial 0" notice.
- **Agents**: add/remove them from the `/admin` dashboard (no restart
  needed — it's live immediately, and permanent once Redis is set up per
  "Persistent storage" above), or edit `agents.json` by hand and redeploy.
- **Admin password**: edit `admin.json` (`{"password": "..."}`) and
  redeploy.
