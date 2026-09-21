# Virtual Front Desk — Video Concierge Prototype

A working prototype that lets a hotel guest walk up to a lobby kiosk/tablet,
tap a department, and be connected by live video to a remote agent —
without installing anything or downloading an app.

Two screens, one server:

- **Kiosk** (`/`) — the guest-facing screen for a lobby tablet.
- **Agent Dashboard** (`/agent`) — where remote staff sign in, watch the
  queue, and take calls.

Zero npm dependencies. The signaling server is ~350 lines of plain Node
(built-in `http` module, plus a small hand-rolled WebSocket implementation),
so `npm install` isn't needed and there's nothing to audit beyond this repo.

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
   saved to a short in-memory call log (topic, agent, duration, notes)
   shown in the dashboard sidebar.
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

## What's real vs. what's stubbed (read before deploying)

This is a functioning prototype, not a hardened product. Before putting it
in a real lobby:

- **HTTPS is required.** Browsers only allow camera/mic access
  (`getUserMedia`) on `https://` or `localhost`. Put this behind a reverse
  proxy (Caddy, nginx, or a platform like Render/Fly.io) with a real
  certificate before it touches a guest-facing tablet.
- **Add a TURN server.** Both `kiosk.js` and `agent.js` only configure a
  public STUN server (`stun.l.google.com`). STUN is enough on an open
  network, but a hotel's guest wifi or corporate firewall will often block
  direct peer-to-peer connections outright. Without TURN, some calls will
  simply never connect video. Add your TURN credentials to the
  `ICE_SERVERS` array in both files — a managed TURN service (Twilio,
  Cloudflare Calls, Xirsys) is the easiest path.
- **Replace the PIN login.** `agents.json` is a flat file for the demo.
  Swap `handleAgentConnection`'s PIN check in `server.js` for real auth
  (SSO, your PMS's staff directory, per-shift codes, etc.) before this is
  used with real guests.
- **State is in-memory.** The queue, active calls, and call log all live
  in the Node process's memory — a restart clears everything, and it
  can't run as multiple load-balanced instances as-is. Fine for a single
  lobby kiosk; for multi-property or multi-instance deployment, move
  queue/call state to Redis (or similar) and keep only the WebRTC
  signaling relay per-instance.
- **No recording, transcripts, or PMS integration.** Calls are pure
  peer-to-peer video; nothing is stored beyond the short in-memory call
  log (topic, agent, duration, notes), which resets on server restart.
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
├── server.js       Signaling server: WebSocket relay, queue, agent auth, static hosting
├── agents.json     Demo agent PINs/names (edit or replace with real auth)
├── package.json
└── public/
    ├── kiosk.html / kiosk.css / kiosk.js   Guest-facing lobby screen
    └── agent.html / agent.css / agent.js   Agent dashboard
```

## Customizing

- **Departments**: edit the `.dept-btn` buttons in `public/kiosk.html`
  (each just needs a `data-topic` attribute).
- **Branding**: colors are CSS custom properties at the top of
  `kiosk.css` / `agent.css` (`--bg`, `--accent`, etc.); swap the 🛎️ emoji
  for a logo image.
- **Wait-time warning**: `WAIT_WARNING_MS` in `kiosk.js` (default 60s)
  controls when the kiosk shows the "still connecting… dial 0" notice.
- **Agents**: add entries to `agents.json` — no server restart needed
  beyond a normal deploy, since it's read at startup.
