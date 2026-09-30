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
  kiosk accounts, and checks each agent's call performance.

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
   given call — the server settles ties. **The server also stops the same
   agent from winning two calls at once**, even if they're signed in from
   two places at the same time (a second tab, a phone and a desktop, etc.)
   — agent passwords aren't tied to one device, so nothing stops someone
   from being logged in twice, but a person can only actually be on one
   video call at a time. The moment one of an agent's sessions is on an
   active call, every other session signed in as that same agent gets a
   clear "you're already on a call elsewhere" message if it tries to
   answer another one, instead of silently double-booking them.
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
device signs in with its own **kiosk account** (name + password), managed
from the admin dashboard's [User Management](#user-management) page —
the same way agent accounts are managed:

- **Signing a kiosk in**: opening `/` on a device that isn't signed in
  shows a "Kiosk Sign-in" screen — enter that kiosk's password. On
  success the device is remembered for every call afterwards, across
  browser refreshes (`sessionStorage`, so it clears if the browser/tab is
  fully closed and needs signing in again on restart — see "Single
  session per kiosk" below for why that's the deliberate behavior).
- **One active session per kiosk account**: a kiosk account can only be
  signed in on one device at a time. If a second device tries to sign in
  with the same password while the first is still active, it's rejected
  with a clear "this kiosk is already signed in on another device"
  message — it does not silently boot the first device. Sign the first
  one out (or use the admin dashboard's **Force sign out**, below) to
  free the slot.
- **Signing out**: tap "Sign out" at the bottom of the kiosk's idle
  screen. This also happens automatically, on the server's side, within
  about 20-40 seconds if a signed-in device loses power or network
  entirely without signing out cleanly (the same heartbeat that detects a
  dropped agent or guest connection — see "How it works" above) — so a
  kiosk that's unplugged doesn't leave its account permanently locked out.
- **Managing kiosk accounts**: add, remove, or force-sign-out a kiosk
  account from the admin dashboard's User Management page → **Kiosk
  accounts** panel, the same way agent accounts are managed. Removing an
  account that's currently signed in immediately signs that device out.
- **Renaming a kiosk** (e.g. it's physically moved): there's no separate
  rename — just edit the kiosk's name where its account is managed, or
  remove and re-add it.
- **Giving a kiosk its own look**: assign it to a kiosk group, which can
  optionally override the accent color, logo, and background photo for
  every kiosk in it — see "Kiosk groups" under "Customizing the kiosk's
  branding" below.

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

Demo kiosk account (edit `kiosks.json` to change, or add more from the
admin dashboard's User Management page — see "Multiple kiosks" above):

| Password  | Name  |
|-----------|-------|
| lobby1234 | Lobby |

Open `/agent` in one browser tab/device and `/` in another (signing in
with the kiosk password above) to try the whole flow yourself.

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

## Call recordings

Every call is recorded automatically, from the agent's side. This app
never has the actual audio/video pass through the server (it's
peer-to-peer, or TURN-relayed without touching the server — see above),
so recording happens in the agent's browser: it composites the remote and
local video onto a canvas (the same picture-in-picture layout shown on
screen), mixes both audio tracks, and uploads the result to the server in
a couple of seconds' worth of chunks at a time as the call happens.

- A **🔴 REC** indicator shows on the agent's active-call panel while a
  call is being recorded, and guests see a **"this call may be
  recorded"** notice on the kiosk's in-call screen.
- Once a call ends, its entry in the agent dashboard's "Recent calls" list
  gets a **▶ Play recording** link (may take a couple of seconds to
  appear — the last few seconds of video have to finish uploading first).
- Recordings are `.webm` files (video + audio) saved under `recordings/`
  next to `server.js`, indexed in `recordings/index.json`.
- **Filenames read as `agent-kiosk-ddmmyyyy-hhmm.webm`** — e.g.
  `Alex-PoolDeck-28092026-1453.webm` — so a recording is identifiable at a
  glance in a file browser or the R2 dashboard, without having to open the
  app. The agent and kiosk names are slugified (spaces/punctuation stripped
  down to letters, numbers and hyphens) to keep them filesystem- and
  URL-safe. The date/time is the server's own local time (Node's default
  `Date` behavior) — set the `TZ` environment variable to your hotel's
  timezone (e.g. `Asia/Kuala_Lumpur`) on Render if the server's default
  doesn't already match, so filenames read in local time rather than UTC.
  If the same agent takes two calls at the same kiosk within the same
  minute, the second recording gets a `-2` suffix rather than overwriting
  the first.

### Storage — local disk by default, Cloudflare R2 for real persistence

Without any setup, recordings are stored **on local disk** under
`recordings/` next to `server.js`. That's simple and needs no extra
account, but it comes with the same caveat as `agents.json` without Redis
configured: **on most Render plans, local disk is wiped on every
redeploy and restart.** Recordings pile up while the service stays up,
then disappear the next time it restarts — fine for trying this out, not
fine if you need real guest recordings to survive.

This project uses **Cloudflare R2** (S3-compatible object storage) to fix
that — called from a small client (`r2.js`) that signs requests itself
with AWS Signature V4 using nothing but Node's built-in `crypto`, the
same zero-dependency approach as `turn.js`. Its free tier (10GB storage,
no egress fees) comfortably covers a single hotel's call recordings.

**How it behaves once configured:** each call still stages to local disk
first as it happens (so a recording exists even if the next step hiccups),
then on call end the finished file is uploaded to R2 as one object and the
local copy is deleted. Playback links are short-lived (1 hour) presigned
URLs straight to R2, minted fresh each time the call log loads — the file
itself never passes back through this server. If the R2 upload fails for
any reason (bad credentials, a network blip), the recording is **not
lost** — it just stays on local disk instead, same as if R2 weren't
configured at all.

**If a recording is deleted directly from storage** (someone removes the
object from the R2 bucket, or deletes the file from local disk by hand,
outside this app) — the app catches this rather than leaving a dead link
behind. Every time a call's recording link would be shown, the server
double-checks the file/object is actually still there (a HEAD request to
R2, or a plain file-existence check on local disk) before handing back a
link. If it's gone, the **▶ Play recording** link is replaced with *"Recording
no longer available"* instead of a link that fails when clicked. This check
runs on every load rather than once, so it stays accurate even though this
app has no way to be notified when something is deleted outside it. (A
check that can't get a clear answer — a network blip, a token that can read
objects but not confirm they exist — doesn't hide the recording; it assumes
the link is still good rather than risk hiding one that's actually fine.)

### Setup

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **R2
   Object Storage** (same account as the TURN setup above, if you did
   that) → **Create bucket**. Give it any name, e.g. `vfd-recordings`.
2. Go to **R2** → **Manage API tokens** → **Create API token**. Give it
   **Object Read & Write** permission, scoped to just this bucket if you
   want to be strict about it — this also covers listing the bucket's
   contents, which is all the storage-usage panel (see "Storage usage"
   below) needs. This gives you an **Access Key ID** and a **Secret Access
   Key** — copy both (the secret is only shown once).
3. You'll also need your **Account ID**, shown on the right side of the
   R2 overview page (or in the S3 API endpoint Cloudflare shows you,
   which looks like `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
4. In Render, your service → **Environment**, add:

   | Variable | Value |
   |---|---|
   | `R2_ACCOUNT_ID` | your Cloudflare Account ID |
   | `R2_ACCESS_KEY_ID` | the Access Key ID from step 2 |
   | `R2_SECRET_ACCESS_KEY` | the Secret Access Key from step 2 |
   | `R2_BUCKET` | the bucket name from step 1 |

5. Save, let Render redeploy, and upload `r2.js` (new file) to GitHub
   alongside `server.js` if you haven't already.
6. Open `/agent`, sign in, and check the Render logs for `[recordings]
   Cloudflare R2 configured` at startup to confirm it's active.

No code changes needed — the four env vars are the only thing that turns
it on.

If you'd rather not use R2, adding a **Render persistent disk** to your
service (Render → your service → **Disks**) mounted at `recordings/` is
the other option — cheaper conceptually, no external account, but ties
your recordings to this one Render service rather than portable object
storage.

There's also a generous but real safety cap: a single call's recording
stops accepting new data past **750MB** (`MAX_RECORDING_BYTES` in
`server.js`), far beyond any real front-desk call, just so a stuck upload
can't fill the disk (or run up an R2 bill).

### Reducing file size

Recordings are capped to a **~382 kbps combined video+audio bitrate** by
default (640×360 at 15fps, plus 32kbps audio) — a real talking-head call
typically comes out to **roughly 1.5-2.5 MB per minute**, not the several
times that you'd get from letting the browser pick its own bitrate at full
call resolution.

All four knobs live together at the top of the "Call recording" section in
`public/agent.js`:

```js
const RECORDING_WIDTH = 640;
const RECORDING_HEIGHT = 360;
const RECORDING_FPS = 15;
const RECORDING_VIDEO_BITRATE = 350_000; // ~350 kbps
const RECORDING_AUDIO_BITRATE = 32_000;  // ~32 kbps
```

Turn any of them down for smaller files (e.g. `RECORDING_VIDEO_BITRATE =
200_000` cuts it further, at some cost to sharpness during motion), or up
if a recording ever looks too soft/blocky. These only affect the saved
recording — the live call itself always uses the guest and agent's full
camera resolution, this only controls what gets written to disk/R2.

Recording also always prefers the VP9 codec over VP8 when the browser
supports both (noticeably smaller for the same visual quality), falling
back to VP8 only on a browser that can record but not encode VP9.

### Storage usage

The **Storage** panel on the admin dashboard's Configuration page (see
"Admin dashboard" below) shows how much space your recordings are using
right now:

- **With R2 configured**, it lists the bucket (via the same S3-compatible
  API used to upload/play recordings) and sums up the actual bytes stored,
  shown as a meter against R2's **10GB/month free tier** — green while
  there's plenty of headroom, amber past 60%, red past 90%. That free-tier
  line is just a helpful reference, though, **not a hard cap**: R2 is
  billed usage like any S3-compatible storage, not a fixed-size disk, so
  going over it doesn't block uploads — it just means a small charge
  (currently $0.015/GB-month for the overage; check [Cloudflare's current
  R2 pricing](https://developers.cloudflare.com/r2/pricing/) for the
  latest numbers). There's no API for "space left" because R2 doesn't have
  a ceiling to report one against — actual usage vs. the free tier is the
  closest honest equivalent.
- **Without R2 configured**, it instead sums up whatever's on local disk
  under `recordings/` right now, with a reminder that this disk isn't
  persistent on Render — it's wiped on the next restart/redeploy, so
  there's no fixed capacity to meter it against either.
- Click **Refresh** on the panel to re-check without waiting for the next
  page load. Listing a large bucket can take a moment (it pages through
  1,000 objects at a time), so give it a few seconds on a bucket with a
  lot of recordings.

### A note on consent

Recording laws vary a lot by place — some require only one party to
consent, others require everyone on the call to. This app shows an
on-screen notice to the guest and an indicator to the agent so recording
is never silent, but **it's on you** (the hotel) to make sure recording
every call this way is actually compliant where you operate — check with
whoever handles that for your property before turning this on for real
guest calls.

## Incoming-call ring tone

When a guest starts a call from the kiosk, every signed-in agent's
dashboard plays a repeating "ring…ring…" tone (a couple of quick tones
every ~2 seconds) for as long as that guest is waiting unanswered — not
just a one-off beep, so it's hard to miss if you've stepped away from the
screen.

- The ring stops the instant someone answers (whether that's you or
  another agent), and doesn't play at all while you're already on a call.
- If more than one guest is waiting, it keeps going until the queue is
  empty again — and picks back up if a new guest arrives.
- Each agent has their own 🔔 mute toggle next to "Waiting" in the queue
  panel; muting stops the ring immediately and keeps it off even while a
  guest is waiting, until you unmute it. This preference is remembered
  per browser (not synced between agents or devices).
- It's generated in the browser with the Web Audio API — no sound file
  to host — so it plays as soon as the queue updates, with no extra
  network request.

### Staying connected

The ring (and everything else pushed to the dashboard — the queue,
"Recent calls" updates, chat) only works while the agent dashboard's
WebSocket connection is actually alive. An agent typically leaves that tab
open for hours between calls, which is exactly the situation most likely to
hit a silent network drop — wifi blipping, a laptop sleeping and waking, a
proxy timing out a connection it thinks is idle. If that connection dies
quietly (no clean close, just goes silent) and nothing notices, a call that
comes in afterward would never reach that agent at all — it just wouldn't
ring, with no obvious sign anything was wrong.

Two things guard against this:

- **The server actively checks.** Every 20 seconds it pings each open
  connection and expects a reply before the next ping is due; a connection
  that misses one is assumed dead and torn down right away (ending any call
  it was on, so a guest never gets stuck waiting on an agent who's actually
  gone) instead of silently sticking around.
- **The dashboard reconnects on its own.** If an agent's connection ever
  drops while they're signed in — for this reason or any other — it
  reconnects automatically (with a short backoff, and immediately if you
  switch back to a tab that had gone quiet in the background) rather than
  leaving you stuck until you notice and refresh the page yourself. The dot
  next to your name in the top bar reflects this: green while connected,
  amber while it's reconnecting.

### A locked phone/tablet screen is a harder problem — read this if agents use mobile

**Once a device's screen locks, the browser tab is frozen by the OS** —
timers stop, the ring tone's audio context is suspended, and eventually the
WebSocket itself gets throttled. This isn't specific to this app: *no*
website can make sound, show a notification, or run code once the screen is
locked, because the OS itself pauses the browser to save battery. If an
agent's phone locks while a guest is waiting, nothing will ring or notify
them until they unlock it and the page catches back up.

- **The dashboard requests a screen Wake Lock the moment you sign in**
  (a small ☀ indicator lights up next to your name in the top bar while
  it's held) — this keeps the device from auto-locking on its own timeout
  for as long as the tab stays open and visible, the same way a video-call
  app keeps your screen on during a call. It's a genuine fix for the most
  common case (a phone or tablet timing out after sitting idle at the
  desk), and it degrades silently on older browsers that don't support it
  (the indicator just stays hidden).
- **It cannot stop someone manually pressing the lock/power button**, and
  on iPhone it only works in Safari 16.4+ (not older iOS versions, and not
  every in-app browser). For a phone that agents actually carry around and
  might deliberately lock, the only fully reliable fix is real push
  notifications (a service worker + Web Push, or a native app) — a
  meaningfully bigger project than this app currently takes on. In
  practice, the most dependable setup is a dedicated tablet/phone that
  stays plugged in and unlocked at the desk, same as a physical phone
  system would.

## Call hold

An agent can put an active call on hold from the **⏸ Hold** button next
to End Call. The guest and the agent both see an "on hold" screen (the
guest's: *"You're on hold"*; the agent's: a live countdown to when it
auto-resumes), and the agent's mic/camera are muted for the guest for as
long as the hold lasts.

- **There's a maximum hold duration**, set by an admin under **Video call
  configuration** in the `/admin` dashboard (default: 5 minutes). If
  nobody resumes the call manually before that runs out, it **resumes on
  its own** — a guest can never be stuck on hold indefinitely because
  someone forgot about them.
- **The agent is warned 30 seconds before it expires** — the on-hold
  overlay switches to an amber warning state and a short chime plays, so
  there's time to come back before it auto-resumes. (If the admin sets
  the limit to 30 seconds or less, that warning fires immediately when
  the hold starts instead, since there's no 30-seconds-out point to wait
  for.)
- **How it works technically:** rather than renegotiating the WebRTC
  connection, going on hold just disables the agent's own audio/video
  tracks (so the guest gets silence and a frozen frame) while the overlay
  on both ends makes clear why. No media ever touches the server either
  way — see "How it works" above.
- **Hold time is tracked per call** and rolled into each agent's
  performance stats — both the summary row and the full per-call detail
  view (see "Admin dashboard" below) show total hold time and how many
  times a call was put on hold.
- A call can be held and resumed any number of times; the times add up
  across the whole call for stats purposes.

## Multi-language support & call transfer

A guest picks their language on the kiosk before a call starts, and an
agent who can't help can hand the call to one who can — without the guest
ever hanging up.

- **The kiosk asks which language the guest speaks** right after "Start
  Video Call", as a row of big buttons, before it requests camera access.
  **The picker only offers languages at least one agent on the roster is
  actually tagged for** — not the full fixed list below — so a guest is
  never offered a language nobody could ever pick up in the first place.
  This is based on the agent roster, not who's online at that exact
  moment, so it doesn't flicker as people sign in and out over a shift. If
  only one language qualifies (a single-language property, or one that
  just hasn't added a second-language agent yet), this screen is skipped
  automatically and that language is used — no extra tap.
- **Agents are tagged with the language(s) they take calls in** (User
  Management, above) — an agent tagged only "Spanish" only sees Spanish
  calls in their queue; an agent tagged both "English" and "Spanish" sees
  both. **If nobody currently online is tagged for a language at all, that
  call is shown to every agent instead** — a guest is never stranded in
  the queue just because nobody on shift happens to be tagged for the
  language they picked.
- **An agent on a call can transfer it** with the **↪ Transfer** button
  next to Hold — pick the language the guest actually needs and optionally
  leave a short note for whoever picks it up (e.g. *"guest is asking about
  a late checkout"*). The guest is **never disconnected**: they see a
  brief "connecting you to another agent" wait (the same screen as their
  original wait) while the call goes back into the queue — filtered to
  agents who speak the target language, and ahead of anyone else already
  waiting, since this guest has already waited once. Once the next agent
  answers, the video reconnects automatically.
- **The next agent sees the full handoff context** — who transferred it
  and the note they left — right on their call screen, and the same
  context shows on the queue item before they even answer it.
- **Both legs are tracked separately in call history and agent stats** —
  the outgoing agent's segment is recorded as a completed call
  (outcome "transferred", not "ended"), and the agent who eventually
  closes it out gets their own separate entry. Nothing about a transfer
  is invisible in the Agent Performance numbers.
- **Which languages are available to tag agents with is admin-editable —
  no code change needed.** Admin dashboard → Configuration → **Languages**
  lists the full ISO 639-1 catalog (~180 languages) with a checkbox per
  language and a search box; toggle any on/off and hit Save. English can't
  be turned off (every install needs at least one guaranteed language), and
  you can't disable a language an agent is still tagged with — retag them
  first, and the error message tells you who. This replaces the old
  approach of editing a fixed array in `server.js` directly. The enabled
  set is stored in the same app config as the max-hold-duration setting
  (`config.json` locally, or Redis when you've set that up — see
  "Persistent storage" below), so it survives restarts and redeploys the
  same way.
- `/api/call-config` exposes two versions of the language list, both
  scoped to what's currently *enabled* (never the disabled ones): the
  full enabled list (`allLanguages`, what the admin dashboard's language
  checkboxes/chips use, so you can tag a first-of-its-kind language) and
  the roster-scoped one (`languages`, what the kiosk picker and an agent's
  Transfer-target dropdown use — only languages some agent is actually
  tagged for, as described above).
- **Agents created before this feature existed** are migrated to the base
  language (English by default) the first time the server starts after
  upgrading, so nobody's calls silently stop routing to them.

## Guest ratings

After a call ends, the kiosk asks the guest to rate it — a quick way to
see how agents are actually doing, straight from the people they helped.

- **Shown automatically whenever a call actually connected** — whether the
  agent ended it or the guest hung up. A guest who cancels before an agent
  even answers never sees it, since there's no completed call to rate.
- **1 to 5 stars, plus an optional name and remarks.** Tapping a star
  reveals the optional name/remarks fields and a Submit button; there's
  also a "No thanks" link for guests who'd rather skip it.
- **Not a hard stop** — if the guest walks away without doing anything,
  the kiosk gives up after 45 seconds and returns to the idle screen on
  its own, the same way it always has.
- **Folded into that agent's performance stats** — both the summary row
  and the full per-call detail view in the `/admin` dashboard (see "Admin
  dashboard" below) show the average rating and how many ratings it's
  based on; the detail view also shows each individual rating — stars,
  the guest's name (if given), and their remarks (if any) — next to the
  call it belongs to.
- **The submit endpoint is intentionally open** (no admin/agent password
  needed) — a guest rating a call has no account to authenticate with,
  the same reasoning as the password-reset request endpoint below. It
  only accepts a rating for a call that's actually in the call log, so it
  can't be used to inject made-up data.

## Admin dashboard

Open `/admin` and sign in with the admin password (default `letmein`,
stored in `admin.json` — **change it before real use**, the same way you'd
change the demo agent passwords).

The dashboard is organized into four pages, switched from the nav bar under
the header — **Dashboard** is what you land on right after signing in.

- **Stay signed in across a page refresh** — both `/agent` and `/admin`
  remember your session (via the browser's `sessionStorage`) until you
  click **Sign out** or close the tab. Refreshing the page — or the
  browser reconnecting after a Render free-tier cold start — no longer
  drops you back to the sign-in screen.
- **Change the admin password** — click the ⚙ button next to "Refresh" in
  the header (this stays available on every page), enter the current
  password and a new one. Takes effect immediately (your own session keeps
  working without needing to sign in again).
- A small **online / waiting / on-a-call** summary in the header always
  reflects what's happening *right now*, independent of whatever the
  Dashboard page's filters are set to.

### Dashboard

The default landing page — a combined view of call activity across every
agent and kiosk, filterable by:

- **Date range** — presets for Today, Last 7/30/90 days, This month, All
  time, or a custom from/to range (pick the same day twice to look at just
  that day, or a range spanning a month to look at just that month).
- **Agent** — including agents that have since been removed; their
  historical calls stay filterable by name.
- **Kiosk** — every kiosk that's ever logged a call.

The filters scope everything below them at once — the stat tiles (calls,
**not answered**, average and total talk time, hold time, average rating)
and the **calls over time** chart, which you can switch between daily and
monthly bars. Picking a wide date range with daily bars automatically
switches to monthly instead, rather than rendering a chart with hundreds
of slivers.

**Not answered** counts guests who called in but never got connected to an
agent — they either gave up and tapped "Cancel" while waiting, or lost
their connection (closed the tab, network dropped) before anyone picked
up. It's tracked entirely separately from the "Calls" tile, which only
ever counts calls an agent actually answered, so one number never leaks
into the other. Since these calls never had an agent, filtering the
Dashboard to one specific agent always shows **0** here — pick "All
agents" (or filter by kiosk only) to see it. Like the rest of the
Dashboard, it resets to the last 200 entries on a restart unless
[persistent storage](#persistent-storage-agents--call-history) is set up.

### Agent Performance

A per-agent breakdown, with its own **date range** filter (All time,
Today, Last 7/30/90 days, This month, or a custom From/To range) — separate
from the Dashboard's filters above, so you can look at, say, this agent's
last 90 days without disturbing whatever range the Dashboard is showing.
It defaults to **All time** (or however far back your call history goes;
see "Persistent storage" below), matching how this page behaved before the
filter existed. It shows:

- A **calls handled per agent** bar chart and an **average rating per
  agent** bar chart (agents with no ratings yet are left off the second
  one). Hover or focus a bar for its exact value; **click a bar to open
  that agent's detail view**, same as clicking their name below.
- **Agent details** — the full per-agent list (calls, average/total talk
  time, most common kiosk, hold time, rating, last call). **Click any
  agent's row for their complete call history and recordings**: every
  call with its date, duration, hold time, agent notes, a **▶ Play
  recording** link where one exists, and the guest's rating (stars, name,
  remarks) where one was given — including calls from before these
  features existed (older entries just won't show a hold time or rating,
  since neither was tracked yet).

The detail view honors whichever date range is currently selected on this
page, so the totals you see there always match the row or bar you clicked.
An agent who's been removed still keeps their calls in the chart/table for
any range that covers them; an agent who's on file but simply had no calls
in the selected range shows a row with **0 calls** rather than disappearing.

### User Management

Agent accounts and password resets, previously mixed in with everything
else:

- **Add an agent** — enter a name, a password (at least 4 characters,
  letters/numbers/symbols all fine), and tick which language(s) they take
  calls in; it's added to the agent list immediately (agents can sign in
  at `/agent` right away, no restart needed).
- **Remove an agent** — click "Remove" on any agent's row (asks for
  confirmation first).
- **Change an agent's password** — click "Change password" on their row and
  set a new one directly (at least 4 characters) — no need to wait for them
  to request a reset. They start using it on their next sign-in; any
  session they're already signed in on keeps working until they sign out
  or the connection drops.
- **Change an agent's language(s)** — click any language chip on their row
  to toggle it on/off; saves immediately, no separate edit mode. See
  "Multi-language support & call transfer" below.
- **Handle password reset requests** — see "Password resets" below. A red
  badge on the User Management tab itself, not just inside the page, shows
  when one is waiting so it's hard to miss even from another page.
- **Kiosk accounts** — a separate panel below Agents for managing the
  login each physical kiosk device signs in with:
  - **Add a kiosk** — enter a name (e.g. "Lobby", "Pool Deck") and a
    password (at least 4 characters); it's usable at `/` right away.
  - **Remove a kiosk** — click "Remove" on its row (asks for confirmation
    first). If that account is currently signed in on a device, that
    device is immediately signed out.
  - **Change a kiosk's password** — click "Change password" on its row and
    set a new one directly. Unlike an agent's password change, this also
    immediately signs out any device currently signed in on that account
    (its stored password for auto-relogin would otherwise silently stop
    working the next time it reconnects) — so the physical kiosk will show
    its sign-in screen again until someone enters the new password.
  - **Signed in / Not signed in** — a live status chip on each row shows
    whether that kiosk account currently has an active device session
    (see "Single session per kiosk" under "Multiple kiosks" above).
  - **Force sign out** — enabled only when a kiosk is signed in; use it to
    reclaim a session slot without waiting for the ~20-40s automatic
    cleanup (e.g. a tablet that was powered off without signing out
    cleanly, or to hand the same password to a replacement device right
    away).
  - **Group** — assign this kiosk to a kiosk group (or "No group" for the
    site-wide default look) from the dropdown on its row. Branding itself
    is set per group, not per kiosk — see "Kiosk groups" just below.

- **Kiosk groups** — a separate panel for managing branding shared across
  kiosks:
  - **Add a group** — enter a name (e.g. "East Wing", "Pool Deck").
  - **Branding…** — set the accent color, logo, and/or background photo
    for every kiosk assigned to this group; a "Custom branding" badge
    shows on any group that has an override set. See "Kiosk groups" under
    "Customizing the kiosk's branding" below.
  - **Rename** — change the group's name.
  - **Remove** — click "Remove" on its row (asks for confirmation first,
    and says how many kiosks are assigned). Any kiosk assigned to it falls
    back to the site-wide default look, live if it's currently signed in.

### Configuration

- **Maximum hold duration** — see "Call hold" above.
- **Languages** — turn on/off which of the ~180 ISO 639-1 languages are
  available for tagging agents and for guests to pick on the kiosk; see
  "Multi-language support & call transfer" above.
- **Storage** — how much recording storage is currently in use, and where;
  see "Storage usage" under "Call recordings" below.
- **Kiosk appearance (logo size)** — set the pixel size (24–320px) of the
  logo shown on the kiosk's sign-in and idle screens. This is the
  site-wide default; a kiosk group with its own uploaded logo (see "Kiosk
  groups" above) is still sized by this setting, so raising it there
  enlarges every kiosk's logo — custom or default — at once. Applies live
  to any kiosk already sitting on its sign-in/idle screen, no reload
  needed.

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
the last 200 calls since the last restart. A small note under the stats on
both the Dashboard and Agent Performance pages always tells you which mode
you're in.

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

To make agents, the admin password, call history (answered and
not-answered), guest ratings, and app config (the video call configuration
under "Call hold" above) **permanent — surviving restarts and redeploys,
with true all-time history** — connect a free
[Upstash](https://upstash.com) Redis database. It's a small cloud
database reached over plain HTTPS, so no extra npm packages are needed, and
it has a generous free tier that easily covers a single hotel's traffic.
(Password reset *requests* are the one exception — see "Password resets"
above — those stay in-memory even with Redis configured, by design. Call
*recordings* are a separate exception too — this Redis setup doesn't
cover them either way; they use their own Cloudflare R2 setup instead,
see "Call recordings" below.)

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
are in place and the service has redeployed, open `/admin` — the note on
the Dashboard or Agent Performance page should say stats are persisted to
Redis. From then on,
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
- **Recordings need R2 configured (or a persistent disk) to actually
  persist.** See "Call recordings" above — without `R2_ACCOUNT_ID` /
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` set,
  recordings stay on local disk, which most Render plans wipe on every
  redeploy/restart. There's also no transcript or PMS integration — just
  the video/audio file itself plus topic/agent/duration/notes in the call
  log.
- **No multi-device ringing / overflow routing.** Any signed-in agent can
  answer any waiting call; there's no skill-based routing, no
  "ring all agents then escalate," and no SMS/callback fallback if no
  agent is available. The kiosk just tells the guest to dial 0 if the
  wait is long.
- **Kiosk has no idle/attract screen or accessibility pass.** It's built
  for a touchscreen but hasn't been tested with a screen reader, and there's
  no auto-lock/timeout if a guest walks away mid-flow beyond the call
  itself ending.

## Clearing test data before go-live

Once you've finished testing (placing calls, trying transfers, rating
calls), you'll want a clean slate before real guests start using it —
otherwise your first "real" call history is mixed in with test entries, and
your recordings folder/bucket has test footage in it.

`clear-test-data.js` (in the project root) does this in one step. It wipes:

- Call history and missed calls
- WhatsApp/Messenger chat conversations
- Guest ratings
- Recordings — both the R2 bucket (if configured) and local disk

It deliberately leaves alone your **agent roster, kiosk accounts, admin
password, and app config** (max hold time, enabled languages) — those are
real setup, not test data.

Run it with the same environment variables your deployed service uses
(`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, and the `R2_*` vars if
you're using R2) — either from Render's **Shell** tab on the service itself
(those vars are already set there), or locally with them exported in your
shell:

```
node clear-test-data.js            # dry run — shows what's there, deletes nothing
node clear-test-data.js --yes      # actually deletes it
```

**Then restart or redeploy the service.** This script only clears what's
*persisted* (Redis + R2/local disk) — a running service is still holding
its own in-memory copy of that same data (normal; see "Persistent storage"
above) and will keep serving it until it restarts. Run the script, then
restart, in that order.

If you're not using Upstash/R2 at all (relying on the in-memory-only
fallback), you don't need the script — just restart the service and
everything test-related is gone, since none of it was ever persisted.

A note on **logs**: this only clears the app's own data stores, not your
hosting platform's console/request logs (e.g. Render's Logs tab). Those can
contain guest phone numbers, chat messages, or names from your testing.
Render logs roll off on their own (retention depends on your plan), but if
you want them gone sooner, check Render's log retention/export settings —
there's no in-app control for this since it's platform-level, not something
this server generates a persistent file for.

## Project layout

```
virtual-front-desk/
├── server.js       Signaling server: WS relay, queue, agent auth, admin API, webhooks, static hosting
├── store.js        Persistence layer: Upstash Redis if configured, else local-only fallback
├── chat.js         WhatsApp/Messenger: Graph API sending, webhook signature check + parsing
├── turn.js         Cloudflare TURN: mints short-lived WebRTC relay credentials per call
├── r2.js           Cloudflare R2: signs S3-compatible requests to upload/serve/list call recordings
├── agents.json     Seed/fallback agent passwords/names — real source of truth is Redis once configured
├── kiosks.json     Seed/fallback kiosk account passwords/names — real source of truth is Redis once configured
├── admin.json      Admin dashboard password (default "letmein" — change this)
├── config.json     Seed/fallback video call configuration (currently: max hold duration)
├── recordings/     Call recordings (.webm) + index.json — local staging always, final home unless R2 is configured (see "Call recordings")
├── package.json
└── public/
    ├── kiosk.html / kiosk.css / kiosk.js   Guest-facing lobby screen
    ├── branding/                           Site-wide kiosk logo/icon/background — see "Customizing the kiosk's branding"
    │   └── groups/<id>/                    Kiosk group branding overrides, uploaded from the admin dashboard (created on demand)
    ├── agent.html / agent.css / agent.js   Agent dashboard (calls + WhatsApp/Messenger chats)
    └── admin.html / admin.css / admin.js   Admin dashboard (Dashboard, Agent Performance, User Management, Configuration)
```

## Customizing

- **Departments**: the kiosk currently only offers "Front Desk" — to bring
  back other departments (Concierge, Housekeeping, etc.), add more buttons
  with a `data-topic` attribute back into `public/kiosk.html`'s idle
  screen (each needs its own click listener like `btn-start-call`'s in
  `kiosk.js`).
- **Colors**: CSS custom properties at the top of `kiosk.css` / `agent.css`
  (`--bg`, `--accent`, etc.).
- **Kiosk logo, start-button icon, and background image** — see below.
- **Wait-time warning**: `WAIT_WARNING_MS` in `kiosk.js` (default 60s)
  controls when the kiosk shows the "still connecting… dial 0" notice.
- **Agents**: add/remove them from the `/admin` dashboard (no restart
  needed — it's live immediately, and permanent once Redis is set up per
  "Persistent storage" above), or edit `agents.json` by hand and redeploy.
- **Admin password**: edit `admin.json` (`{"password": "..."}`) and
  redeploy.

### Customizing the kiosk's branding

There are two layers of branding, applied in order: a **site-wide
default** (files in `public/branding/`, used by every kiosk that isn't in
a group with its own branding) and an optional **kiosk group override**
(set from the admin dashboard, applies to every kiosk account assigned to
that group — see "Kiosk groups" below). Neither touches the agent or admin
dashboards — this is the guest-facing kiosk screen only.

#### Site-wide default

The kiosk's logo, its Start Video Call button icon, and its background all
come from three files under `public/branding/`, ready to swap out without
touching any HTML or CSS:

| What | File | Format | Default |
|---|---|---|---|
| Logo (shown on the setup and idle screens) | `public/branding/logo.svg` | SVG | a simple bell mark |
| Start-button icon | `public/branding/start-icon.svg` | SVG | a simple suitcase |
| Background (setup, idle, waiting, ended, error screens) | `public/branding/background.jpg` | JPG or PNG | none — a plain white/light-blue gradient is used instead |

**To use your own logo or icon:** replace `logo.svg` / `start-icon.svg`
with your own SVG file of the same name (any image editor or "export as
SVG" from your logo source works). If you only have a PNG or JPG version,
that's fine too — just save it into `public/branding/` (e.g.
`logo.png`) and change the one matching `src="branding/logo.svg"`
attribute in `public/kiosk.html` (there are two, both commented) to point
at your filename instead.

**To use your own background photo:** just add a file named
`public/branding/background.jpg` (landscape, at least 1920×1080 works
well) — no code changes needed. It's automatically detected and shown
under a near-white wash so on-screen text stays readable regardless of how
busy the photo is. Using a `.png` instead of `.jpg`? Change the one
`url('branding/background.jpg')` line near the top of `public/kiosk.css`
to match. Leave the file out entirely and the kiosk falls back to a plain
light gradient — never a broken image.

#### Kiosk groups

Since each kiosk device now signs in with its own [kiosk
account](#multiple-kiosks), branding is set on a **kiosk group** and every
kiosk account assigned to that group picks it up — handy for a resort with
visually distinct zones (e.g. a beach-themed Pool Deck group vs. the main
Lobby's look), a property with several kiosks that should all match, or
white-labeling a set of kiosks for a co-branded partner area. A kiosk
assigned to no group just uses the site-wide default above.

Manage it from the admin dashboard: **User Management → Kiosk groups**.
Create a group, then:

1. Click **"Branding…"** on the group's row to set its look. Three
   independent overrides, all optional — leave any of them unset and that
   piece falls back to the site-wide default:
   - **Accent color** — replaces the button/highlight color (`#016FB7` by
     default) for every kiosk in this group. A slightly darker shade for
     pressed/hover states is derived from it automatically.
   - **Logo** — PNG, JPEG, WEBP, or SVG, up to 5MB.
   - **Background photo** — PNG, JPEG, or WEBP, up to 5MB.
2. Assign kiosks to it from the **Group** dropdown on each row in the
   **Kiosk accounts** panel just below. Reassigning a kiosk (or moving it
   back to "No group") takes effect immediately, live, if that kiosk is
   currently signed in — no sign-out needed.

Uploaded images are stored under
`public/branding/groups/<group-id>/` and served by the same static file
server as the rest of `public/` — no separate object storage needed for
this (unlike call recordings, which can optionally go to R2). Removing a
kiosk group also deletes its uploaded branding files; any kiosk that was
assigned to it falls back to the site-wide default look (live, if it's
currently signed in) rather than being left pointing at a group that no
longer exists.

Branding applies the moment a kiosk device signs in, and updates live
(no sign-out needed) if you change the group's branding, or reassign the
kiosk to a different group, from the admin dashboard while that kiosk is
already signed in.
