# Virtual Front Desk — Video Concierge Prototype

A working prototype that lets a hotel guest walk up to a lobby kiosk/tablet,
tap a department, and be connected by live video to a remote agent —
without installing anything or downloading an app.

Three screens, one server:

- **Kiosk** (`/`) — the guest-facing screen for a lobby tablet.
- **Agent Dashboard** (`/agent`) — where remote staff sign in, watch the
  queue, and take calls.
- **Admin Dashboard** (`/admin`) — where a manager adds/removes agents and
  checks each agent's call performance.

Zero npm dependencies. The signaling server is plain Node (built-in `http`
module, plus a small hand-rolled WebSocket implementation), and persistence
(see below) talks to Upstash Redis over plain HTTPS using the `fetch` Node
already has built in — so `npm install` isn't needed and there's nothing to
audit beyond this repo.

## How it works

1. Guest taps a department on the kiosk → browser asks for camera/mic
   access → guest is added to a server-side queue for that call.
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

Demo agent PINs (edit `agents.json` to change, or add more agents):

| PIN  | Name |
|------|------|
| 1234 | Alex |
| 5678 | Sam  |

Open `/agent` in one browser tab/device and `/` in another to try the
whole flow yourself.

## Admin dashboard

Open `/admin` and sign in with the admin password (default `letmein`,
stored in `admin.json` — **change it before real use**, the same way you'd
change the demo agent PINs).

From the dashboard you can:

- **Add an agent** — enter a name and a PIN; it's added to the agent list
  immediately (agents can sign in at `/agent` right away, no restart
  needed).
- **Remove an agent** — click "Remove" on any agent's row (asks for
  confirmation first).
- **See performance per agent** — calls handled, total and average talk
  time, most common call topic, and time of their last call. A summary
  line at the top shows how many agents are currently online, how many
  guests are waiting, and how many calls are active right now. The
  dashboard refreshes itself every 10 seconds, or click "Refresh" for an
  immediate update.

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
demo-grade auth used for agent PINs. Treat it the same way: fine for a
small team getting started, swap for real auth (SSO, a proper user table)
before this is relied on operationally.

## Persistent storage (agents + call history)

By default, agents you add/remove through `/admin` and the call history
behind its performance stats live only in the running server's memory (and
a local `agents.json`, which itself resets on a host like Render — see
below). That's fine for trying things out, but not for actually relying on
it: a restart, a spin-down (free Render instances sleep after inactivity),
or your next deploy wipes it clean.

To make agents and call history **permanent — surviving restarts and
redeploys, with true all-time history** — connect a free
[Upstash](https://upstash.com) Redis database. It's a small cloud database
reached over plain HTTPS, so no extra npm packages are needed, and it has
a generous free tier that easily covers a single hotel's traffic.

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

## What's real vs. what's stubbed (read before deploying)

## What's real vs. what's stubbed (read before deploying)

This is a functioning prototype, not a hardened product. Before putting it
in a real lobby:

- **HTTPS is required.** Browsers only allow camera/mic access
  (`getUserMedia`) on `https://` or `localhost`. Put this behind a reverse
  proxy (Caddy, nginx, or a platform like Render/Fly.io) with a real
  certificate before it touches a guest-facing tablet.
- **The TURN server currently configured is a free testing relay.** Both
  `kiosk.js` and `agent.js` are set up with a free Metered.ca TURN account
  (`global.relay.metered.ca`) so calls can connect even when devices are on
  a network that blocks direct peer-to-peer connections — this is common on
  hotel guest wifi and behind many home/office routers (a router feature
  called "client isolation"), and without a TURN relay affected calls just
  hang with no video and no error. The free tier has limited bandwidth and
  isn't meant for real guest traffic — before going live, sign up for your
  own TURN credentials (Metered's own paid plan, or Twilio, Cloudflare
  Calls, Xirsys) and swap them into the `ICE_SERVERS` array in both files.
- **Replace the PIN login and the admin password.** `agents.json` and
  `admin.json` are flat files for the demo. Swap `handleAgentConnection`'s
  PIN check and the admin API's password check in `server.js` for real
  auth (SSO, your PMS's staff directory, per-shift codes, etc.) before
  this is used with real guests or handed to real managers.
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
├── server.js       Signaling server: WebSocket relay, queue, agent auth, admin API, static hosting
├── store.js        Persistence layer: Upstash Redis if configured, else local-only fallback
├── agents.json     Seed/fallback agent PINs/names — real source of truth is Redis once configured
├── admin.json      Admin dashboard password (default "letmein" — change this)
├── package.json
└── public/
    ├── kiosk.html / kiosk.css / kiosk.js   Guest-facing lobby screen
    ├── agent.html / agent.css / agent.js   Agent dashboard
    └── admin.html / admin.css / admin.js   Admin dashboard (add/remove agents, view stats)
```

## Customizing

- **Departments**: edit the `.dept-btn` buttons in `public/kiosk.html`
  (each just needs a `data-topic` attribute).
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
