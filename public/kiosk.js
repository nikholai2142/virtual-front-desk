'use strict';

// Used only if the server can't be reached at all for /api/turn-credentials
// (a network hiccup) — the server is the real source of ICE servers now,
// since Cloudflare's TURN credentials are short-lived and minted per call
// rather than hardcoded here. See turn.js / server.js.
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

async function getIceServers() {
  try {
    const res = await fetch('/api/turn-credentials');
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
  } catch (err) {
    console.warn('Could not fetch TURN credentials, falling back to STUN-only:', err);
  }
  return FALLBACK_ICE_SERVERS;
}

const WAIT_WARNING_MS = 60 * 1000;
const IDLE_RESET_MS = 4000;
// The rating prompt gets much longer than a plain "call ended" screen, since
// a guest needs time to tap stars and type optional remarks. If they never
// interact, this is the fallback that still returns the kiosk to idle.
const RATING_AUTO_RESET_MS = 45 * 1000;
const RATING_THANKS_RESET_MS = 3000;
const CONNECT_TIMEOUT_MS = 15 * 1000; // if WebRTC never reaches "connected" in this window
                                        // (most commonly: no TURN server and the network
                                        // blocks direct peer-to-peer), fail loudly instead
                                        // of leaving the guest staring at a blank screen.

// ---- Kiosk identity / login ---------------------------------------------
// Each kiosk device signs in with its own kiosk account (name + password,
// managed in the admin dashboard) instead of a free-text label. The server
// enforces exactly one active session per kiosk account (see server.js's
// kioskSessions map), so a second device signing in with the same password
// is rejected with reason:'already-active' until the first signs out — or
// its connection drops and the server's own heartbeat notices (typically
// within ~20-40s).
//
// sessionStorage (not localStorage), matching agent.js's convention:
// survives a page refresh but clears when the browser/tab fully closes, so
// a kiosk that reboots has to sign in again — which also frees up the
// session slot if the device lost power without signing out cleanly.
const KIOSK_PASSWORD_STORAGE_KEY = 'vfd_kiosk_password';
// Handed back by the server on kiosk-login-ok and replayed on every
// relogin attempt (manual retype or the automatic isReconnect kind). It's
// how the server tells a page-refresh reconnect (same session, brand-new
// WebSocket) apart from a genuinely different device signing in with the
// same password — see the isSameSessionReconnect comment in server.js's
// kiosk-login handler for why that distinction needs a token rather than
// just noticing the old connection is still registered.
const KIOSK_SESSION_TOKEN_STORAGE_KEY = 'vfd_kiosk_session_token';
const KIOSK_LOGIN_TIMEOUT_MS = 20000; // Render free-tier cold starts can take ~30-60s;
                                       // this at least turns a silent hang into a visible message.
const KIOSK_RECONNECT_MS = 4000; // fixed interval — simpler than agent.js's exponential
                                  // backoff, appropriate for an unattended device that
                                  // should just keep trying until the server is back.

let kioskName = null;
let kioskLoginInProgress = false;
let lastKioskLoginPassword = null;
let kioskLoginTimeoutHandle = null;
let kioskReconnectTimer = null;

function setKioskLoginBusy(busy) {
  const btn = document.querySelector('#kiosk-login-form button[type="submit"]');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Signing in…' : 'Sign In'; }
}

function setKioskLoginMessage(text, { error = true } = {}) {
  const el = document.getElementById('kiosk-login-error');
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.style.color = error ? '' : 'var(--sub)';
  el.classList.remove('hidden');
}

function showKioskLoginError(text) {
  kioskLoginInProgress = false;
  clearTimeout(kioskLoginTimeoutHandle);
  setKioskLoginBusy(false);
  setKioskLoginMessage(text, { error: true });
}

// ---- Sign-out confirmation modal (guards the idle screen's "Sign out"
// link — see kiosk.html's comment on #kiosk-signout-modal) ----
function setKioskSignoutBusy(busy) {
  const btn = document.querySelector('#kiosk-signout-form button[type="submit"]');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Signing out…' : 'Sign Out'; }
}

function setKioskSignoutMessage(text) {
  const el = document.getElementById('kiosk-signout-error');
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

function openKioskSignoutModal() {
  document.getElementById('kiosk-signout-input').value = '';
  setKioskSignoutMessage(null);
  setKioskSignoutBusy(false);
  document.getElementById('kiosk-signout-modal').classList.remove('hidden');
  document.getElementById('kiosk-signout-input').focus();
}

function closeKioskSignoutModal() {
  document.getElementById('kiosk-signout-modal').classList.add('hidden');
  document.getElementById('kiosk-signout-input').value = '';
  setKioskSignoutMessage(null);
}

function scheduleKioskReconnect() {
  clearTimeout(kioskReconnectTimer);
  kioskReconnectTimer = setTimeout(() => {
    kioskReconnectTimer = null;
    const password = sessionStorage.getItem(KIOSK_PASSWORD_STORAGE_KEY);
    if (password) loginKiosk(password, { isReconnect: true });
  }, KIOSK_RECONNECT_MS);
}

function loginKiosk(password, { isReconnect = false } = {}) {
  kioskLoginInProgress = true;
  lastKioskLoginPassword = password;
  if (!isReconnect) {
    setKioskLoginBusy(true);
    setKioskLoginMessage(null);
  }

  connectWS()
    .then(() => {
      const sessionToken = sessionStorage.getItem(KIOSK_SESSION_TOKEN_STORAGE_KEY);
      wsSend({ type: 'kiosk-login', password, sessionToken: sessionToken || undefined });
      clearTimeout(kioskLoginTimeoutHandle);
      kioskLoginTimeoutHandle = setTimeout(() => {
        if (kioskLoginInProgress) {
          if (!isReconnect) {
            showKioskLoginError('No response from the server after 20s. If this app was asleep it can take up to a minute to wake up — try again.');
          }
          try { ws.close(); } catch { /* ignore */ }
        }
      }, KIOSK_LOGIN_TIMEOUT_MS);
    })
    .catch(() => {
      kioskLoginInProgress = false;
      if (isReconnect) {
        scheduleKioskReconnect();
      } else {
        showKioskLoginError('Could not reach the front desk. Please try again.');
      }
    });
}

const screens = {};
document.querySelectorAll('.screen').forEach((el) => (screens[el.id] = el));
function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
}

// ---- Per-kiosk branding --------------------------------------------------
// Overrides the global kiosk.css look (accent color, logo, background
// photo) for whichever kiosk account this device is signed in as — set
// from the admin dashboard's Kiosk Accounts panel. Any field a kiosk
// account doesn't override just falls back to the site-wide default
// (kiosk.css's :root values and public/branding/logo.svg /
// background.jpg), so a kiosk with no branding configured looks exactly
// like it did before this feature existed.
const DEFAULT_LOGO_SRC = 'branding/logo.svg';

/** Darkens a #rrggbb hex color by `amount` (0-1) — used to derive --accent-2
 *  (the pressed/hover shade) from a single admin-supplied accent color,
 *  the same relationship the default theme's --accent/--accent-2 have. */
function darkenHex(hex, amount = 0.18) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const channel = (shift) => {
    const v = Math.round(((num >> shift) & 0xff) * (1 - amount));
    return v.toString(16).padStart(2, '0');
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function applyKioskBranding(branding) {
  branding = branding || {};
  const root = document.documentElement.style;

  if (branding.accentColor && /^#[0-9a-fA-F]{6}$/.test(branding.accentColor)) {
    root.setProperty('--accent', branding.accentColor);
    root.setProperty('--accent-2', darkenHex(branding.accentColor));
  } else {
    root.removeProperty('--accent');
    root.removeProperty('--accent-2');
  }

  document.querySelectorAll('.brand-mark').forEach((img) => {
    img.src = branding.logoUrl || DEFAULT_LOGO_SRC;
  });

  if (branding.backgroundUrl) {
    // Same layered wash + fallback gradient as kiosk.css's default
    // background-image, just with the kiosk-specific photo swapped in —
    // an inline style here simply wins the cascade over the stylesheet
    // rule, no !important needed.
    document.body.style.backgroundImage =
      `linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.96)), ` +
      `url('${branding.backgroundUrl}'), ` +
      `linear-gradient(160deg, #ffffff 0%, #eef4f9 100%)`;
  } else {
    document.body.style.backgroundImage = ''; // falls back to kiosk.css's default
  }
}

let ws = null;
let pc = null;
let localStream = null;
let currentTopic = null;
let waitStartedAt = null;
let waitTimerHandle = null;
let callStartedAt = null;
let callTimerHandle = null;
let micOn = true;
let camOn = true;
let connectTimeoutHandle = null;

// ---- Language picker -----------------------------------------------------
// Fetched once at boot from the server (the source of truth — see
// SUPPORTED_LANGUAGES in server.js) so this list can never drift out of
// sync with what agents can actually be tagged for. Falls back to English
// only if the request fails, so the kiosk still works through a hiccup.
let availableLanguages = [{ code: 'en', label: 'English' }];
let currentLanguage = 'en';
let pendingTopic = null;

async function loadCallConfig() {
  try {
    const res = await fetch('/api/call-config');
    const data = await res.json();
    if (Array.isArray(data.languages) && data.languages.length) availableLanguages = data.languages;
    // Admin-configurable logo size (Configuration > Kiosk appearance) — a
    // CSS custom property so .brand-mark (kiosk.css) picks it up for both
    // the login and idle screens' logos in one place. Falls back to
    // kiosk.css's own 72px default if this is missing/invalid.
    const logoSize = Number(data.logoSizePx);
    if (Number.isFinite(logoSize) && logoSize > 0) {
      document.documentElement.style.setProperty('--logo-size', `${logoSize}px`);
    }
  } catch (err) {
    console.warn('Could not fetch call config, defaulting to English only / 72px logo:', err);
  }
}
loadCallConfig();

// ---- Post-call rating ----
let currentCallId = null;
let currentAgentName = null;
let selectedStars = 0;
let endedResetHandle = null;

let wsOpenPromise = null;

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return wsOpenPromise;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=guest`);

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', onWsClose);

  wsOpenPromise = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return wsOpenPromise;
}

function onWsClose() {
  // A sign-out confirmation in flight when the connection drops would
  // otherwise be stuck on "Signing out…" forever (the kiosk reconnects
  // and relogs in below, but that ack for the logout attempt is never
  // coming) — reset it rather than leaving a dead button behind.
  if (!document.getElementById('kiosk-signout-modal').classList.contains('hidden')) {
    setKioskSignoutBusy(false);
    setKioskSignoutMessage('Lost connection — try again.');
  }

  const wasOnCall = screens['screen-call'].classList.contains('active') ||
                     screens['screen-waiting'].classList.contains('active');
  if (kioskName) {
    // We were signed in and the connection dropped unexpectedly (network
    // blip, server restart) rather than via an explicit sign-out. Clean up
    // any in-progress call silently and try to resume the same kiosk
    // session automatically, rather than stranding an unattended device on
    // a dead-end error screen.
    kioskName = null;
    if (wasOnCall) cleanupCall();
    showScreen('screen-kiosk-setup');
    const password = sessionStorage.getItem(KIOSK_PASSWORD_STORAGE_KEY);
    if (password) {
      setKioskLoginMessage('Reconnecting…', { error: false });
      setKioskLoginBusy(true);
      loginKiosk(password, { isReconnect: true });
    }
    return;
  }
  if (wasOnCall) {
    showError('Connection lost', 'We lost the connection to the front desk. Please try again.');
    cleanupCall();
  }
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'kiosk-login-ok':
      kioskLoginInProgress = false;
      clearTimeout(kioskLoginTimeoutHandle);
      clearTimeout(kioskReconnectTimer);
      kioskReconnectTimer = null;
      setKioskLoginBusy(false);
      setKioskLoginMessage(null);
      kioskName = msg.name;
      sessionStorage.setItem(KIOSK_PASSWORD_STORAGE_KEY, lastKioskLoginPassword);
      if (msg.sessionToken) sessionStorage.setItem(KIOSK_SESSION_TOKEN_STORAGE_KEY, msg.sessionToken);
      document.getElementById('kiosk-id-label').textContent = kioskName;
      applyKioskBranding(msg.branding);
      showScreen('screen-idle');
      break;

    case 'kiosk-login-fail':
      kioskLoginInProgress = false;
      clearTimeout(kioskLoginTimeoutHandle);
      sessionStorage.removeItem(KIOSK_PASSWORD_STORAGE_KEY);
      sessionStorage.removeItem(KIOSK_SESSION_TOKEN_STORAGE_KEY);
      applyKioskBranding(null); // back to the site-wide default look
      showScreen('screen-kiosk-setup');
      if (msg.reason === 'already-active') {
        showKioskLoginError('This kiosk is already signed in on another device. Sign it out there first, or ask an admin to force a sign-out.');
      } else {
        showKioskLoginError('Incorrect kiosk password. Try again.');
      }
      break;

    case 'kiosk-logout-ok':
      kioskName = null;
      sessionStorage.removeItem(KIOSK_PASSWORD_STORAGE_KEY);
      sessionStorage.removeItem(KIOSK_SESSION_TOKEN_STORAGE_KEY);
      document.getElementById('kiosk-login-input').value = '';
      setKioskLoginMessage(null);
      closeKioskSignoutModal();
      applyKioskBranding(null); // back to the site-wide default look
      showScreen('screen-kiosk-setup');
      break;

    case 'kiosk-logout-fail':
      // Wrong password on the sign-out confirmation — stay signed in and
      // keep the modal open rather than treating this like a real sign-out.
      setKioskSignoutBusy(false);
      setKioskSignoutMessage('Incorrect password.');
      document.getElementById('kiosk-signout-input').value = '';
      document.getElementById('kiosk-signout-input').focus();
      break;

    case 'kiosk-forced-logout':
      kioskName = null;
      sessionStorage.removeItem(KIOSK_PASSWORD_STORAGE_KEY);
      sessionStorage.removeItem(KIOSK_SESSION_TOKEN_STORAGE_KEY);
      cleanupCall();
      applyKioskBranding(null); // back to the site-wide default look
      showScreen('screen-kiosk-setup');
      showKioskLoginError(
        msg.reason === 'account-removed'
          ? 'This kiosk account was removed by an admin. Contact your administrator.'
          : 'This kiosk was signed out by an admin.'
      );
      break;

    // An admin changed this kiosk's branding while it's signed in (see the
    // admin dashboard's Kiosk Accounts panel) — applied live so a change
    // shows up immediately rather than needing a sign-out/back-in.
    case 'kiosk-branding-updated':
      applyKioskBranding(msg.branding);
      break;

    case 'queued':
      currentCallId = msg.callId;
      document.getElementById('waiting-title').textContent = 'Connecting you to the next available agent…';
      showScreen('screen-waiting');
      document.getElementById('waiting-topic').textContent = currentTopic;
      waitStartedAt = Date.now();
      startWaitTimer();
      break;

    case 'call-accepted':
      currentAgentName = msg.agentName;
      document.getElementById('call-agent-name').textContent = `${msg.agentName} · ${currentTopic}`;
      stopWaitTimer();
      await startPeerConnection();
      showScreen('screen-call');
      callStartedAt = Date.now();
      startCallTimer();
      break;

    case 'signal':
      await handleSignal(msg.signalType, msg.data);
      break;

    case 'call-hold':
      document.getElementById('hold-overlay').classList.remove('hidden');
      break;

    case 'call-resumed':
      document.getElementById('hold-overlay').classList.add('hidden');
      break;

    // The agent on the call just handed it back into the queue for someone
    // else to pick up (see agent.js's Transfer button) — the guest never
    // hung up, so this tears down the peer connection to the outgoing
    // agent (without touching the camera/mic, which stay live) and shows
    // the same waiting UI as the original wait, just reworded, until the
    // next agent answers and a fresh 'call-accepted' arrives.
    case 'call-transferring':
      stopCallTimer();
      teardownPeerConnectionOnly();
      document.getElementById('waiting-title').textContent = 'Connecting you to another agent…';
      document.getElementById('waiting-topic').textContent = currentTopic;
      waitStartedAt = Date.now();
      showScreen('screen-waiting');
      startWaitTimer();
      break;

    case 'call-ended':
      const reasonText = {
        'agent-ended': 'The agent ended the call.',
        'agent-disconnected': 'The agent lost connection. Please try again.',
      }[msg.reason] || 'We hope we could help. Have a great stay.';
      document.getElementById('ended-message').textContent = reasonText;
      cleanupCall();
      showEndedScreen();
      break;
  }
}

// ---- Post-call rating -----------------------------------------------------
// Shown on the "ended" screen whenever this call actually connected (we have
// a callId from the 'queued' message). A guest who cancels before connecting
// never sees it — there's no completed call to rate.
function showEndedScreen() {
  clearTimeout(endedResetHandle);
  showScreen('screen-ended');
  if (currentCallId) {
    showRatingPrompt();
    endedResetHandle = setTimeout(finishEndedScreen, RATING_AUTO_RESET_MS);
  } else {
    document.getElementById('rating-prompt').classList.add('hidden');
    document.getElementById('rating-thanks').classList.add('hidden');
    endedResetHandle = setTimeout(finishEndedScreen, IDLE_RESET_MS);
  }
}

function finishEndedScreen() {
  clearTimeout(endedResetHandle);
  endedResetHandle = null;
  currentCallId = null;
  currentAgentName = null;
  resetToIdle();
}

function showRatingPrompt() {
  selectedStars = 0;
  document.getElementById('rating-prompt').classList.remove('hidden');
  document.getElementById('rating-thanks').classList.add('hidden');
  document.getElementById('rating-details').classList.add('hidden');
  document.getElementById('rating-name').value = '';
  document.getElementById('rating-remarks').value = '';
  document.getElementById('rating-question').textContent = currentAgentName
    ? `How was your call with ${currentAgentName}?`
    : 'How was your call?';
  updateStarDisplay(0);
}

function updateStarDisplay(stars) {
  document.querySelectorAll('.star-btn').forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.star) <= stars);
  });
}

async function submitRating() {
  const callId = currentCallId;
  const btn = document.getElementById('btn-submit-rating');
  btn.disabled = true;
  try {
    await fetch('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId,
        stars: selectedStars,
        guestName: document.getElementById('rating-name').value,
        remarks: document.getElementById('rating-remarks').value,
      }),
    });
  } catch (err) {
    console.warn('Could not submit rating:', err);
  }
  document.getElementById('rating-prompt').classList.add('hidden');
  document.getElementById('rating-thanks').classList.remove('hidden');
  clearTimeout(endedResetHandle);
  endedResetHandle = setTimeout(finishEndedScreen, RATING_THANKS_RESET_MS);
}

// ICE candidates can arrive (via the 'signal' WS message handler above,
// which does not wait for each async handleSignal() call to finish before
// the next message is dispatched) before setRemoteDescription() for the
// answer has resolved. Calling addIceCandidate() with no remote
// description yet throws, and that failure was previously being silently
// swallowed — dropping candidates the connection needed, which was
// causing calls to fail to connect and get killed by the connect timeout.
// Buffering until the remote description is set (then flushing) is the
// standard fix.
let pendingIceCandidates = [];

async function handleSignal(signalType, data) {
  if (!pc) return;
  if (signalType === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const queued = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ICE add failed', e); }
    }
  } else if (signalType === 'ice') {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(data); } catch (e) { console.warn('ICE add failed', e); }
    } else {
      pendingIceCandidates.push(data);
    }
  }
}

async function startPeerConnection() {
  if (pc) { pc.close(); pc = null; } // defensive — should already be null (see teardownPeerConnectionOnly)
  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (evt) => {
    document.getElementById('remote-video').srcObject = evt.streams[0];
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) wsSend({ type: 'signal', signalType: 'ice', data: evt.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    console.warn('Peer connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      clearTimeout(connectTimeoutHandle);
    } else if (pc.connectionState === 'failed') {
      clearTimeout(connectTimeoutHandle);
      failConnection();
    }
  };

  clearTimeout(connectTimeoutHandle);
  connectTimeoutHandle = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') failConnection();
  }, CONNECT_TIMEOUT_MS);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: 'signal', signalType: 'offer', data: offer });
}

function failConnection() {
  wsSend({ type: 'hangup' });
  cleanupCall();
  showError(
    'Could not connect',
    'We could not establish a stable video connection. This usually means the network is blocking a direct connection between devices — please try again, or dial 0 from a house phone.'
  );
}

// Shown after "Start Video Call", before camera permission — lets the guest
// pick a language so the queue can route (or later transfer) them to an
// agent who speaks it. Skipped automatically when only one language is
// configured, so a single-language property sees no extra tap.
function maybeShowLanguageScreen(topic) {
  pendingTopic = topic;
  if (availableLanguages.length <= 1) {
    requestMediaAndJoin(topic, availableLanguages[0] ? availableLanguages[0].code : 'en');
    return;
  }
  const list = document.getElementById('language-list');
  list.innerHTML = '';
  availableLanguages.forEach((lang) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'language-btn';
    btn.textContent = lang.label;
    btn.addEventListener('click', () => requestMediaAndJoin(topic, lang.code));
    list.appendChild(btn);
  });
  showScreen('screen-language');
}

async function requestMediaAndJoin(topic, language) {
  currentTopic = topic;
  currentLanguage = language || 'en';
  showScreen('screen-connecting');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local-video').srcObject = localStream;
  } catch (err) {
    showError('Camera access needed', 'Please allow camera and microphone access, then try again.');
    return;
  }

  document.getElementById('connecting-title').textContent = 'Finding an available agent…';
  document.getElementById('connecting-sub').textContent = '';

  if (!kioskName || !ws || ws.readyState !== WebSocket.OPEN) {
    // The session dropped between the idle screen and tapping "Start" (a
    // brief network blip) — onWsClose() already kicked off a relogin, but
    // it hasn't landed yet. Sending an unauthenticated join-queue would
    // just be ignored by the server, so send the guest back instead of
    // leaving them stuck on the connecting screen.
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    showError('Connection lost', 'We lost the connection to the front desk. Please try again.');
    return;
  }
  wsSend({ type: 'join-queue', topic, language: currentLanguage });
}

function startWaitTimer() {
  document.getElementById('waiting-warning').classList.add('hidden');
  waitTimerHandle = setInterval(() => {
    const elapsed = Date.now() - waitStartedAt;
    document.getElementById('waiting-time').textContent = formatTime(elapsed);
    if (elapsed > WAIT_WARNING_MS) {
      document.getElementById('waiting-warning').classList.remove('hidden');
    }
  }, 1000);
}
function stopWaitTimer() {
  clearInterval(waitTimerHandle);
  waitTimerHandle = null;
}

function startCallTimer() {
  callTimerHandle = setInterval(() => {
    document.getElementById('call-timer').textContent = formatTime(Date.now() - callStartedAt);
  }, 1000);
}
function stopCallTimer() {
  clearInterval(callTimerHandle);
  callTimerHandle = null;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function cleanupCall() {
  stopWaitTimer();
  stopCallTimer();
  clearTimeout(connectTimeoutHandle);
  pendingIceCandidates = [];
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  micOn = true; camOn = true;
  document.getElementById('hold-overlay').classList.add('hidden');
}

/**
 * Closes just the WebRTC peer connection to the current agent, leaving the
 * camera/mic (localStream) running — used for a transfer, where the guest
 * is about to be connected to a DIFFERENT agent and shouldn't have to
 * re-grant camera/mic permission (or see the picture flicker off) for a
 * call they never actually ended. startPeerConnection() builds a fresh
 * `pc` from the same localStream once the next agent answers.
 */
function teardownPeerConnectionOnly() {
  clearTimeout(connectTimeoutHandle);
  pendingIceCandidates = [];
  if (pc) { pc.close(); pc = null; }
  document.getElementById('hold-overlay').classList.add('hidden');
}

function showError(title, message) {
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = message;
  showScreen('screen-error');
  cleanupCall();
}

function resetToIdle() {
  showScreen('screen-idle');
}

// ---- UI wiring ----
document.getElementById('btn-start-call').addEventListener('click', (e) => {
  maybeShowLanguageScreen(e.currentTarget.dataset.topic);
});

document.getElementById('btn-cancel-language').addEventListener('click', () => {
  pendingTopic = null;
  showScreen('screen-idle');
});

document.getElementById('kiosk-login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('kiosk-login-input').value;
  if (!value) return;
  loginKiosk(value, { isReconnect: false });
});

document.getElementById('btn-kiosk-sign-out').addEventListener('click', () => {
  openKioskSignoutModal();
});

document.getElementById('btn-cancel-signout').addEventListener('click', () => {
  closeKioskSignoutModal();
});

document.getElementById('kiosk-signout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('kiosk-signout-input').value;
  if (!value) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setKioskSignoutMessage('Not connected right now — try again in a moment.');
    return;
  }
  setKioskSignoutBusy(true);
  setKioskSignoutMessage(null);
  wsSend({ type: 'kiosk-logout', password: value });
});

document.getElementById('btn-cancel-connecting').addEventListener('click', () => {
  cleanupCall();
  resetToIdle();
});

document.getElementById('btn-cancel-waiting').addEventListener('click', () => {
  wsSend({ type: 'cancel-wait' });
  cleanupCall();
  resetToIdle();
});

document.getElementById('btn-hangup').addEventListener('click', () => {
  // The guest hung up on a call that had actually connected (this button
  // only exists on the in-call screen) — that's still a completed call
  // worth rating, so route through the same ended/rating flow as a call
  // the agent ended, instead of jumping straight back to idle.
  wsSend({ type: 'hangup' });
  cleanupCall();
  document.getElementById('ended-message').textContent = 'We hope we could help. Have a great stay.';
  showEndedScreen();
});

document.getElementById('btn-error-retry').addEventListener('click', resetToIdle);

document.getElementById('btn-toggle-mic').addEventListener('click', (e) => {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  e.currentTarget.classList.toggle('off', !micOn);
  e.currentTarget.textContent = micOn ? '🎤' : '🔇';
});

document.getElementById('btn-toggle-cam').addEventListener('click', (e) => {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  e.currentTarget.classList.toggle('off', !camOn);
});

document.querySelectorAll('.star-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedStars = Number(btn.dataset.star);
    updateStarDisplay(selectedStars);
    document.getElementById('rating-details').classList.remove('hidden');
  });
});

document.getElementById('btn-submit-rating').addEventListener('click', () => {
  if (selectedStars < 1) return;
  submitRating();
});

document.getElementById('btn-skip-rating').addEventListener('click', () => {
  finishEndedScreen();
});

showScreen('screen-kiosk-setup');
const storedKioskPassword = sessionStorage.getItem(KIOSK_PASSWORD_STORAGE_KEY);
if (storedKioskPassword) {
  setKioskLoginMessage('Signing in…', { error: false });
  setKioskLoginBusy(true);
  loginKiosk(storedKioskPassword, { isReconnect: true });
} else {
  connectWS().catch(() => {}); // pre-connect so signing in is instant once a password is entered
}
