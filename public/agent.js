'use strict';

// See kiosk.js for the same note: ICE servers now come from the server's
// /api/turn-credentials endpoint (Cloudflare TURN, minted per call) rather
// than a hardcoded array here. This is only the last-resort fallback if
// that request itself fails.
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

const screens = {};
document.querySelectorAll('.screen').forEach((el) => (screens[el.id] = el));
function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
}

let ws = null;
let pc = null;
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let currentTopic = null;
let currentKioskId = null;
let callStartedAt = null;
let callTimerHandle = null;
let noteDebounce = null;
let micOn = true;
let camOn = true;
let chatConversations = new Map(); // conversationId -> conversation
let selectedChatId = null;
let connectTimeoutHandle = null;
const CONNECT_TIMEOUT_MS = 15 * 1000; // see kiosk.js for why this exists
let recording = null; // active call-recording session, see startRecording() below

// ---- Call hold -----------------------------------------------------------
let onHold = false;
let holdDeadline = null; // ms epoch — when the current hold auto-resumes
let holdCountdownHandle = null;
let configuredMaxHoldSeconds = 300; // refreshed from the server, see refreshCallConfig()

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 180);
  } catch { /* ignore */ }
}

// ---- Incoming-call ring tone ---------------------------------------------
// A single beep() on a new queue arrival is easy to miss if the agent isn't
// looking at the screen. This plays a repeating two-pulse "ring…ring…" tone
// (like a phone) for as long as a guest is waiting and this agent is free to
// take the call, and stops the moment it's answered (by this agent or
// another) or the agent goes into their own call.
const RING_MUTED_STORAGE_KEY = 'vfd_ring_muted';
let ringMuted = localStorage.getItem(RING_MUTED_STORAGE_KEY) === '1';
let ringAudioCtx = null;
let ringIntervalHandle = null;
let ringActive = false;
let lastQueueLength = 0;

function playRingPulse() {
  try {
    if (!ringAudioCtx) ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = ringAudioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    // Two short tones back-to-back, like a phone bell's double ring.
    [0, 0.28].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 950;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.linearRampToValueAtTime(0.16, now + offset + 0.02);
      gain.gain.linearRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.24);
    });
  } catch { /* ignore */ }
}

function startRinging() {
  if (ringActive || ringMuted) return;
  ringActive = true;
  playRingPulse();
  ringIntervalHandle = setInterval(playRingPulse, 2200);
}

function stopRinging() {
  ringActive = false;
  clearInterval(ringIntervalHandle);
  ringIntervalHandle = null;
}

/** Call after anything that could change whether we should be ringing: a queue update, answering a call, or a call ending. */
function updateRingingState() {
  if (lastQueueLength > 0 && !currentCallId && !ringMuted) {
    startRinging();
  } else {
    stopRinging();
  }
}

// sessionStorage (not localStorage): survives a page refresh, but clears
// when the tab/window closes — matches "stay signed in for this session"
// without leaving the password sitting around indefinitely on a shared
// front-desk computer.
const STORAGE_KEY = 'vfd_agent_password';

const LOGIN_TIMEOUT_MS = 20000; // Render free-tier cold starts can take ~30-60s;
                                 // this at least turns a silent hang into a visible message.
let loginInProgress = false;
let loginTimeoutHandle = null;
let lastLoginPassword = null;
let pendingChangePasswordNew = null;

function setLoginBusy(busy) {
  const btn = document.getElementById('login-submit');
  btn.disabled = busy;
  btn.textContent = busy ? 'Connecting…' : 'Sign In';
}

function showLoginError(text) {
  loginInProgress = false;
  clearTimeout(loginTimeoutHandle);
  setLoginBusy(false);
  const el = document.getElementById('login-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

// ---- Reconnecting ----------------------------------------------------
// The dashboard's WebSocket has to sit open for however long an agent goes
// between calls — sometimes hours — which is exactly the situation most
// likely to hit a silent network drop: wifi blipping, a laptop sleeping and
// waking, a proxy timing out a connection it thinks is idle. Before this,
// a lost connection just turned the status dot red and sat there forever —
// nothing reconnected, so no new 'queue-update' (and the ring that comes
// with it) could ever arrive again. A call that came in after that point
// would never ring, with no sign anything was wrong beyond a small dot
// changing color. This reconnects automatically instead, with backoff, and
// also retries immediately when the tab becomes visible again (an agent is
// far more likely to check a tab right after switching back to it than to
// be staring at it when the backoff timer happens to fire).
let signedOutIntentionally = false;
let reconnecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

function setConnectionStatus(state) {
  const dot = document.getElementById('agent-status-dot');
  if (state === 'connected') {
    dot.style.background = 'var(--good)';
    dot.title = 'Connected';
  } else if (state === 'reconnecting') {
    dot.style.background = '#f6c76a';
    dot.title = 'Reconnecting…';
  } else {
    dot.style.background = 'var(--danger)';
    dot.title = 'Disconnected';
  }
}

function scheduleReconnect() {
  if (signedOutIntentionally || reconnectTimer) return;
  setConnectionStatus('reconnecting');
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (signedOutIntentionally) return;
    const password = sessionStorage.getItem(STORAGE_KEY);
    if (password) connectWS(password, { isReconnect: true });
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || signedOutIntentionally) return;
  if (!screens['screen-dashboard'].classList.contains('active')) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // Coming back to a hidden tab — don't make the agent wait out whatever
  // backoff delay happened to be in progress.
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const password = sessionStorage.getItem(STORAGE_KEY);
  if (password) connectWS(password, { isReconnect: true });
});

function connectWS(password, { isReconnect = false } = {}) {
  loginInProgress = true;
  lastLoginPassword = password;
  reconnecting = isReconnect;
  if (!isReconnect) setLoginBusy(true);
  document.getElementById('login-error').classList.add('hidden');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws?role=agent`);
  } catch {
    loginInProgress = false;
    if (isReconnect) scheduleReconnect();
    else showLoginError('Could not start a connection. Check the URL and try again.');
    return;
  }
  ws = socket;

  clearTimeout(loginTimeoutHandle);
  loginTimeoutHandle = setTimeout(() => {
    if (loginInProgress) {
      if (!isReconnect) {
        showLoginError('No response from the server after 20s. If this app was asleep it can take up to a minute to wake up — try again.');
      }
      try { socket.close(); } catch { /* ignore */ }
    }
  }, LOGIN_TIMEOUT_MS);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'agent-login', password }));
  });

  socket.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  socket.addEventListener('error', () => {
    if (loginInProgress && !isReconnect) showLoginError('Connection error. Please try again.');
  });

  socket.addEventListener('close', () => {
    if (loginInProgress) {
      if (isReconnect) {
        loginInProgress = false;
        scheduleReconnect();
      } else {
        showLoginError('Connection closed before signing in. Please try again.');
      }
    } else if (screens['screen-dashboard'].classList.contains('active')) {
      // The connection dropped while signed in. The server's own
      // dead-connection detection (see server.js's keepalive interval) has
      // almost certainly already ended any call we were on by now, so bring
      // the local UI in line with that rather than leaving an active-call
      // screen up for a call that's already over on the server's side.
      if (currentCallId) endActiveCallUI();
      scheduleReconnect();
    }
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'agent-login-ok':
      loginInProgress = false;
      clearTimeout(loginTimeoutHandle);
      setLoginBusy(false);
      reconnectAttempt = 0;
      setConnectionStatus('connected');
      sessionStorage.setItem(STORAGE_KEY, lastLoginPassword);
      document.getElementById('agent-name-label').textContent = msg.name;
      showScreen('screen-dashboard');
      wsSend({ type: 'get-log' });
      wsSend({ type: 'get-chats' });
      break;

    case 'agent-login-fail':
      sessionStorage.removeItem(STORAGE_KEY);
      if (reconnecting) {
        // The stored password stopped working while we were disconnected
        // (e.g. an admin reset it) — retrying it forever would never
        // succeed, so drop back to the login screen instead of silently
        // spinning on a password that's never going to work again.
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        showScreen('screen-login');
      }
      showLoginError('Incorrect password. Try again.');
      break;

    case 'queue-update':
      renderQueue(msg.queue);
      break;

    case 'answer-failed':
      if (msg.reason === 'already-on-a-call') {
        alert("You're already on a call in another session (another tab, phone, or browser signed in as you) — end that one before answering here.");
      } else {
        alert('That call was already answered by another agent.');
      }
      updateRingingState(); // this tab didn't actually answer — resume ringing if guests are still waiting
      break;

    case 'call-assigned':
      currentCallId = msg.callId;
      currentTopic = msg.topic;
      currentKioskId = msg.kioskId;
      updateRingingState();
      startAsAnswerer();
      break;

    case 'signal':
      handleSignal(msg.signalType, msg.data);
      break;

    case 'call-log':
      renderCallLog(msg.entries);
      break;

    case 'call-log-changed':
      // The shared "Recent calls" list changed because *some* call just
      // ended — not necessarily one this agent was on, so this can arrive
      // with no active call of our own in progress. Just re-fetch it.
      wsSend({ type: 'get-log' });
      break;

    case 'call-hold':
      handleHoldStarted(msg.maxHoldSeconds, msg.holdStartedAt);
      break;

    case 'hold-expiring-soon':
      handleHoldExpiringSoon(msg.secondsLeft);
      break;

    case 'call-resumed':
      handleHoldResumed(msg.reason);
      break;

    case 'call-ended':
      // Always clean up and refresh the log here — this message only ever
      // arrives for a call this agent was on. (Previously this was gated on
      // currentCallId still being set, which broke the log refresh
      // specifically when the agent clicked "End Call" themselves: that
      // button already clears currentCallId locally for instant UI
      // feedback, so by the time this echo arrived the check always failed.)
      endActiveCallUI();
      wsSend({ type: 'get-log' });
      break;

    case 'chat-list':
      chatConversations = new Map(msg.conversations.map((c) => [c.id, c]));
      renderChatsList();
      if (selectedChatId && chatConversations.has(selectedChatId)) renderThread(chatConversations.get(selectedChatId));
      break;

    case 'chat-update': {
      const prev = chatConversations.get(msg.conversation.id);
      const lastMsg = msg.conversation.messages[msg.conversation.messages.length - 1];
      const isNewInbound = lastMsg && lastMsg.direction === 'in' &&
        (!prev || msg.conversation.messages.length > prev.messages.length);
      chatConversations.set(msg.conversation.id, msg.conversation);
      renderChatsList();
      if (selectedChatId === msg.conversation.id) renderThread(msg.conversation);
      if (isNewInbound) beep();
      break;
    }

    case 'chat-send-failed': {
      const errEl = document.getElementById('thread-send-error');
      errEl.textContent = 'Could not send: ' + msg.error;
      errEl.classList.remove('hidden');
      break;
    }

    case 'change-password-ok': {
      const okEl = document.getElementById('change-password-success');
      okEl.textContent = (msg.persistenceConfigured && msg.persisted === false)
        ? 'Password updated, but could not reach persistent storage — this change may be lost if the server restarts.'
        : 'Password updated.';
      okEl.classList.remove('hidden');
      if (pendingChangePasswordNew) {
        lastLoginPassword = pendingChangePasswordNew;
        sessionStorage.setItem(STORAGE_KEY, pendingChangePasswordNew);
        pendingChangePasswordNew = null;
      }
      setTimeout(() => document.getElementById('change-password-modal').classList.add('hidden'), 1200);
      break;
    }

    case 'change-password-fail': {
      const errEl = document.getElementById('change-password-error');
      const messages = {
        'incorrect-current-password': 'Current password is incorrect.',
        'too-short': 'New password must be at least 4 characters.',
        'in-use': 'That password is already in use by another agent.',
      };
      errEl.textContent = messages[msg.reason] || 'Could not update password.';
      errEl.classList.remove('hidden');
      break;
    }
  }
}

function chatDisplayName(convo) {
  if (convo.contactName) return convo.contactName;
  if (convo.platform === 'whatsapp') return convo.contactId;
  return `Messenger guest •${convo.contactId.slice(-4)}`;
}

function renderChatsList() {
  const list = document.getElementById('chats-list');
  const conversations = [...chatConversations.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  const unreadCount = conversations.filter((c) => c.unread).length;
  const badge = document.getElementById('chat-unread-badge');
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (!conversations.length) {
    list.innerHTML = '<p class="empty-note">No conversations yet. Messages guests send to WhatsApp or Facebook will show up here.</p>';
    return;
  }

  list.innerHTML = '';
  conversations.forEach((c) => {
    const last = c.messages[c.messages.length - 1];
    const div = document.createElement('div');
    div.className = 'chat-item' + (c.unread ? ' unread' : '') + (c.id === selectedChatId ? ' selected' : '');
    const icon = c.platform === 'whatsapp' ? '🟢' : '🔵';
    div.innerHTML = `
      <div class="ci-top">
        <span class="ci-name"><span class="ci-platform">${icon}</span>${escapeHtml(chatDisplayName(c))}${c.unread ? '<span class="unread-dot"></span>' : ''}</span>
        <span class="ci-time">${last ? new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div class="ci-preview">${last ? escapeHtml(last.text) : ''}</div>
    `;
    div.addEventListener('click', () => selectChat(c.id));
    list.appendChild(div);
  });
}

function selectChat(id) {
  selectedChatId = id;
  const convo = chatConversations.get(id);
  if (!convo) return;
  renderChatsList();
  renderThread(convo);
  if (convo.unread) wsSend({ type: 'chat-mark-read', conversationId: id });
}

function renderThread(convo) {
  document.getElementById('no-thread-placeholder').classList.add('hidden');
  document.getElementById('active-thread').classList.remove('hidden');
  document.getElementById('thread-send-error').classList.add('hidden');
  document.getElementById('thread-platform-icon').textContent = convo.platform === 'whatsapp' ? '🟢' : '🔵';
  const platformLabel = convo.platform === 'whatsapp' ? 'WhatsApp' : 'Messenger';
  document.getElementById('thread-contact-label').textContent = `${chatDisplayName(convo)} (${platformLabel})`;

  const box = document.getElementById('thread-messages');
  box.innerHTML = '';
  convo.messages.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'msg-bubble ' + m.direction;
    const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const agentTag = m.direction === 'out' && m.agentName ? `<span class="msg-agent">${escapeHtml(m.agentName)}</span>` : '';
    div.innerHTML = `${agentTag}${escapeHtml(m.text)}<span class="msg-time">${time}</span>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function renderQueue(queue) {
  document.getElementById('queue-count').textContent = queue.length;
  const list = document.getElementById('queue-list');

  lastQueueLength = queue.length;
  updateRingingState();

  if (queue.length === 0) {
    list.innerHTML = '<p class="empty-note">No guests waiting.</p>';
    return;
  }

  list.innerHTML = '';
  queue.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'queue-item';
    div.innerHTML = `
      <div class="qi-top"><strong>${escapeHtml(item.topic)}</strong><span class="qi-kiosk">${escapeHtml(item.kioskId || '')}</span></div>
      <div class="qi-wait" data-queued-at="${item.queuedAt}">waiting…</div>
      <button data-call-id="${item.callId}">Answer</button>
    `;
    div.querySelector('button').addEventListener('click', () => {
      if (currentCallId) {
        alert('End your current call before answering another.');
        return;
      }
      stopRinging(); // instant feedback — the call-assigned/queue-update round trip is a moment away
      wsSend({ type: 'answer-call', callId: item.callId });
    });
    list.appendChild(div);
  });
}

setInterval(() => {
  document.querySelectorAll('.qi-wait').forEach((el) => {
    const started = Number(el.dataset.queuedAt);
    const s = Math.floor((Date.now() - started) / 1000);
    el.textContent = `waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
}, 1000);

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderCallLog(entries) {
  const box = document.getElementById('call-log');
  if (!entries.length) {
    box.innerHTML = '<p class="empty-note">No calls yet.</p>';
    return;
  }
  box.innerHTML = '';
  entries.forEach((e) => {
    const dur = Math.round((e.endedAt - e.answeredAt) / 1000);
    const div = document.createElement('div');
    div.className = 'call-log-entry';
    const time = new Date(e.answeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const kioskPart = e.kioskId ? ` · ${escapeHtml(e.kioskId)}` : '';
    const holdPart = e.holdSeconds ? ` · on hold ${formatMMSS(e.holdSeconds)}` : '';
    const recordingPart = e.recording
      ? (e.recording.missing
          ? `<div class="log-recording log-recording-missing">Recording no longer available</div>`
          : `<div class="log-recording"><a href="${escapeHtml(e.recording.url)}" target="_blank" rel="noopener">▶ Play recording</a><span class="rec-size">${formatBytes(e.recording.bytes)}</span></div>`)
      : '';
    div.innerHTML = `<strong>${escapeHtml(e.topic)}</strong>${kioskPart} · ${e.agentName || '—'}<br>${time} · ${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}${holdPart}${recordingPart}`;
    box.appendChild(div);
  });
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Fetches the admin-configured max hold duration (no auth needed — see server.js). Best-effort: keeps the last known value on failure. */
async function refreshCallConfig() {
  try {
    const res = await fetch('/api/call-config');
    const data = await res.json();
    if (Number.isFinite(data.maxHoldSeconds)) configuredMaxHoldSeconds = data.maxHoldSeconds;
  } catch { /* keep the previous value */ }
  const holdBtn = document.getElementById('btn-toggle-hold');
  if (holdBtn && !onHold) holdBtn.title = `Put call on hold (auto-resumes after ${formatMMSS(configuredMaxHoldSeconds)})`;
}

function resetHoldUI() {
  onHold = false;
  holdDeadline = null;
  clearInterval(holdCountdownHandle);
  holdCountdownHandle = null;
  document.getElementById('hold-overlay').classList.add('hidden');
  document.getElementById('hold-overlay').classList.remove('expiring');
  document.getElementById('hold-badge').classList.add('hidden');
  const holdBtn = document.getElementById('btn-toggle-hold');
  holdBtn.textContent = '⏸ Hold';
  holdBtn.classList.remove('hold-active');
  holdBtn.disabled = false;
  holdBtn.title = `Put call on hold (auto-resumes after ${formatMMSS(configuredMaxHoldSeconds)})`;
  document.getElementById('btn-toggle-mic').disabled = false;
  document.getElementById('btn-toggle-cam').disabled = false;
}

function tickHoldCountdown() {
  const el = document.getElementById('hold-countdown');
  const remainingMs = holdDeadline - Date.now();
  el.textContent = remainingMs <= 0 ? 'Resuming…' : `Resumes automatically in ${formatMMSS(remainingMs / 1000)}`;
}

/** The call-hold message the server sends back once beginHold() runs — this is what actually flips the UI into "on hold", not the button click itself, so the countdown is always based on the server's authoritative start time. */
function handleHoldStarted(maxHoldSeconds, holdStartedAt) {
  onHold = true;
  holdDeadline = holdStartedAt + maxHoldSeconds * 1000;

  document.getElementById('hold-overlay').classList.remove('hidden');
  document.getElementById('hold-overlay').classList.remove('expiring');
  document.getElementById('hold-badge').classList.remove('hidden');
  const holdBtn = document.getElementById('btn-toggle-hold');
  holdBtn.textContent = '▶ Resume';
  holdBtn.classList.add('hold-active');
  holdBtn.disabled = false;
  holdBtn.title = 'Resume the call';
  document.getElementById('btn-toggle-mic').disabled = true;
  document.getElementById('btn-toggle-cam').disabled = true;

  // No SDP renegotiation — disabling the local tracks is what actually makes
  // this a "hold" for the guest (they get silence / a frozen frame from us),
  // while the on-screen overlay (both sides) makes it obvious why.
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    localStream.getVideoTracks().forEach((t) => (t.enabled = false));
  }

  clearInterval(holdCountdownHandle);
  tickHoldCountdown();
  holdCountdownHandle = setInterval(tickHoldCountdown, 1000);
}

function holdExpiringChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [720, 600, 480].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
      gain.gain.linearRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
    setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 800);
  } catch { /* ignore */ }
}

function handleHoldExpiringSoon(secondsLeft) {
  if (!onHold) return;
  document.getElementById('hold-overlay').classList.add('expiring');
  holdExpiringChime();
}

function handleHoldResumed(reason) {
  resetHoldUI();
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }
}

async function startAsAnswerer() {
  document.getElementById('call-topic-label').textContent = currentKioskId ? `${currentTopic} · ${currentKioskId}` : currentTopic;
  document.getElementById('no-call-placeholder').classList.add('hidden');
  document.getElementById('active-call').classList.remove('hidden');
  document.getElementById('call-notes').value = '';
  resetHoldUI();
  refreshCallConfig();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local-video').srcObject = localStream;
  } catch (err) {
    alert('Camera/microphone access is required to take calls.');
    wsSend({ type: 'end-call', callId: currentCallId });
    endActiveCallUI();
    return;
  }

  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (evt) => {
    remoteStream = evt.streams[0];
    document.getElementById('remote-video').srcObject = remoteStream;
  };
  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      wsSend({ type: 'signal', callId: currentCallId, signalType: 'ice', data: evt.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(connectTimeoutHandle);
      startRecording(currentCallId);
    } else if (pc.connectionState === 'failed') {
      clearTimeout(connectTimeoutHandle);
      failConnection();
    }
  };
  clearTimeout(connectTimeoutHandle);
  connectTimeoutHandle = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') failConnection();
  }, CONNECT_TIMEOUT_MS);

  // pc and its handlers are ready now — process anything (the offer, and
  // any ICE candidates behind it) that arrived while we were still
  // awaiting getUserMedia()/getIceServers() above.
  await flushPendingSignals();

  callStartedAt = Date.now();
  callTimerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    document.getElementById('call-timer-label').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

// ---- Call recording -----------------------------------------------------
// The server never sees a call's live audio/video (it's peer-to-peer, or
// TURN-relayed without touching the server — see turn.js), so recording
// happens here, client-side: draw the remote + local video onto a canvas
// (remote full-frame, local as a small picture-in-picture, matching what's
// on screen), mix both audio tracks through a Web Audio destination, and
// feed the combined stream into MediaRecorder. Chunks are uploaded to the
// server every couple of seconds as the call happens, so a crashed tab
// loses at most a couple of seconds rather than the whole recording.
//
// These four constants are the whole size/quality trade-off. Left at their
// defaults, the video+audio bitrate is capped at ~382 kbps combined, which
// works out to a ceiling of ~2.8 MB/minute — a real talking-head call (not
// much motion) typically lands somewhat under that, closer to 1.5-2.5
// MB/minute. Turn any of these down for smaller files, up for a sharper
// picture:
//   - RECORDING_WIDTH/HEIGHT: the canvas being recorded (not the on-screen
//     video, which stays full quality for the live call itself).
//   - RECORDING_FPS: frames captured per second. Talking heads don't need
//     much — 15 still looks smooth for this kind of call.
//   - RECORDING_VIDEO/AUDIO_BITRATE: hard caps passed to MediaRecorder. This
//     is the single biggest lever — without it, the browser picks its own
//     (often much higher) bitrate and file size is a lot less predictable.
const RECORDING_WIDTH = 640;
const RECORDING_HEIGHT = 360;
const RECORDING_FPS = 15;
const RECORDING_VIDEO_BITRATE = 350_000; // ~350 kbps
const RECORDING_AUDIO_BITRATE = 32_000;  // ~32 kbps — plenty for speech

/** Draws `videoEl` into the (x, y, w, h) box, letterboxed to preserve its aspect ratio. */
function drawContain(ctx, videoEl, x, y, w, h) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(videoEl, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function startRecording(callId) {
  if (recording) return; // already recording this call
  if (typeof MediaRecorder === 'undefined') {
    console.warn('MediaRecorder is not supported in this browser — call will not be recorded.');
    return;
  }

  try {
    const remoteVideoEl = document.getElementById('remote-video');
    const localVideoEl = document.getElementById('local-video');
    const canvas = document.createElement('canvas');
    canvas.width = RECORDING_WIDTH;
    canvas.height = RECORDING_HEIGHT;
    const ctx = canvas.getContext('2d');

    const rec = { callId, rafId: null, uploadChain: Promise.resolve(), seq: 0, mediaRecorder: null, audioCtx: null };
    recording = rec;

    const draw = () => {
      ctx.fillStyle = '#111318';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawContain(ctx, remoteVideoEl, 0, 0, canvas.width, canvas.height);
      const pipW = Math.round(canvas.width * 0.24);
      const pipH = Math.round(pipW * 0.75);
      drawContain(ctx, localVideoEl, canvas.width - pipW - 16, canvas.height - pipH - 16, pipW, pipH);
      rec.rafId = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(RECORDING_FPS);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    rec.audioCtx = audioCtx;
    const dest = audioCtx.createMediaStreamDestination();
    if (localStream && localStream.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(localStream.getAudioTracks())).connect(dest);
    }
    if (remoteStream && remoteStream.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(remoteStream.getAudioTracks())).connect(dest);
    }

    const mixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    // VP9 first: noticeably smaller than VP8 at the same visual quality, and
    // every browser that supports MediaRecorder well enough for this feature
    // (Chrome/Edge/Firefox) also decodes VP9 fine. VP8 stays as a fallback
    // for the rare browser that supports recording but not VP9.
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    const mediaRecorder = new MediaRecorder(mixedStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: RECORDING_VIDEO_BITRATE,
      audioBitsPerSecond: RECORDING_AUDIO_BITRATE,
    });
    rec.mediaRecorder = mediaRecorder;
    rec.mimeType = mediaRecorder.mimeType || mimeType || 'video/webm';

    mediaRecorder.ondataavailable = (evt) => {
      if (!evt.data || evt.data.size === 0) return;
      const mySeq = rec.seq++;
      const blob = evt.data;
      rec.uploadChain = rec.uploadChain
        .then(() => uploadRecordingChunk(rec.callId, mySeq, blob, rec.mimeType))
        .catch((e) => console.warn('Recording chunk upload failed:', e));
    };
    mediaRecorder.start(2000); // 2s chunks — bounds memory and limits data lost to a crash mid-call

    document.getElementById('recording-indicator')?.classList.remove('hidden');
  } catch (err) {
    console.warn('Could not start call recording (continuing without one):', err);
    if (recording && recording.callId === callId) {
      if (recording.rafId) cancelAnimationFrame(recording.rafId);
      recording = null;
    }
  }
}

async function uploadRecordingChunk(callId, seq, blob, mimeType) {
  await fetch(`/api/recordings/chunk?callId=${encodeURIComponent(callId)}&seq=${seq}`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType || 'video/webm' },
    body: blob,
  });
}

/** Stops the active recording (if any) and uploads/finalizes it — fire-and-forget, called from endActiveCallUI(). */
function stopRecording() {
  if (!recording) return;
  const rec = recording;
  recording = null;
  document.getElementById('recording-indicator')?.classList.add('hidden');
  if (rec.rafId) cancelAnimationFrame(rec.rafId);

  (async () => {
    if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        rec.mediaRecorder.addEventListener('stop', resolve, { once: true });
        try { rec.mediaRecorder.stop(); } catch { resolve(); }
      });
    }
    try { await rec.uploadChain; } catch { /* best-effort — a dropped chunk just means a shorter recording */ }
    try { rec.audioCtx.close(); } catch { /* ignore */ }
    try {
      await fetch('/api/recordings/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: rec.callId }),
      });
      // The recording usually finishes uploading a moment after the call
      // log entry itself was created, so refresh the log now that it's
      // actually available to show a playback link for it.
      wsSend({ type: 'get-log' });
    } catch (err) {
      console.warn('Could not finalize the call recording upload:', err);
    }
  })();
}

// See kiosk.js's handleSignal for why this buffer exists: the 'signal' WS
// message handler above does not wait for each async handleSignal() call
// to finish before dispatching the next message, so an ICE candidate can
// arrive while setRemoteDescription() for the offer is still pending.
// addIceCandidate() then throws (no remote description yet) and that was
// being silently swallowed — dropping candidates the connection needed,
// which made calls fail to connect and get killed by the connect timeout
// a few seconds after the agent answered. Buffering until the remote
// description is set, then flushing, is the standard fix.
let pendingIceCandidates = [];

// This is the bigger, related race: the guest sends its offer the moment
// it gets 'call-accepted', but startAsAnswerer() above still has to await
// getUserMedia() (camera/mic prompt) and getIceServers() (a network fetch)
// before `pc` exists here. If the offer — and the ICE candidates right
// behind it — arrive before that finishes, `if (!pc) return;` used to
// silently drop the offer entirely, so no answer was ever sent back.
// That's what "rings, then dies a few seconds later" actually was: not a
// slow network, but the answer never being sent. Queue any signal that
// arrives before `pc` exists, and flush it in order once startAsAnswerer()
// finishes setting up the peer connection.
let pendingSignals = [];

async function flushPendingSignals() {
  const queued = pendingSignals;
  pendingSignals = [];
  for (const { signalType, data } of queued) {
    await handleSignal(signalType, data);
  }
}

async function handleSignal(signalType, data) {
  if (!pc) {
    pendingSignals.push({ signalType, data });
    return;
  }
  if (signalType === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const queued = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ICE add failed', e); }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'signal', callId: currentCallId, signalType: 'answer', data: answer });
  } else if (signalType === 'ice') {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(data); } catch (e) { console.warn('ICE add failed', e); }
    } else {
      pendingIceCandidates.push(data);
    }
  }
}

function endActiveCallUI() {
  stopRecording(); // captures what it needs before pc/localStream are torn down below
  resetHoldUI();
  clearTimeout(connectTimeoutHandle);
  pendingIceCandidates = [];
  pendingSignals = [];
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  remoteStream = null;
  clearInterval(callTimerHandle);
  callTimerHandle = null;
  currentCallId = null;
  currentTopic = null;
  currentKioskId = null;
  micOn = true; camOn = true;
  document.getElementById('active-call').classList.add('hidden');
  document.getElementById('no-call-placeholder').classList.remove('hidden');
  updateRingingState(); // resume ringing if another guest is still waiting
}

function failConnection() {
  if (currentCallId) wsSend({ type: 'end-call', callId: currentCallId });
  endActiveCallUI();
  alert('Could not establish a stable video connection with the guest. This usually means the network is blocking a direct connection between devices — a TURN server needs to be configured (see README).');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- UI wiring ----
document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('login-error').classList.add('hidden');
  const password = document.getElementById('login-password').value.trim();
  if (!password) return;
  connectWS(password);
});

document.getElementById('btn-end-call').addEventListener('click', () => {
  if (currentCallId) wsSend({ type: 'end-call', callId: currentCallId });
  endActiveCallUI();
});

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

document.getElementById('btn-toggle-hold').addEventListener('click', (e) => {
  if (!currentCallId) return;
  e.currentTarget.disabled = true; // re-enabled once the server's call-hold/call-resumed echo arrives
  if (onHold) {
    wsSend({ type: 'resume-call', callId: currentCallId });
  } else {
    wsSend({ type: 'hold-call', callId: currentCallId });
  }
});

function updateRingToggleButton() {
  const btn = document.getElementById('btn-toggle-ring');
  if (!btn) return;
  btn.textContent = ringMuted ? '🔕' : '🔔';
  btn.title = ringMuted ? 'Unmute ring tone' : 'Mute ring tone';
  btn.classList.toggle('muted', ringMuted);
}
updateRingToggleButton();

document.getElementById('btn-toggle-ring').addEventListener('click', () => {
  ringMuted = !ringMuted;
  localStorage.setItem(RING_MUTED_STORAGE_KEY, ringMuted ? '1' : '0');
  updateRingToggleButton();
  updateRingingState();
});

document.getElementById('call-notes').addEventListener('input', (e) => {
  clearTimeout(noteDebounce);
  const text = e.target.value;
  noteDebounce = setTimeout(() => {
    if (currentCallId) wsSend({ type: 'note', callId: currentCallId, text });
  }, 500);
});

window.addEventListener('beforeunload', () => {
  if (currentCallId) wsSend({ type: 'end-call', callId: currentCallId });
});

document.querySelectorAll('.view-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.layout.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
  });
});

document.getElementById('thread-reply-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const textEl = document.getElementById('thread-reply-text');
  const text = textEl.value.trim();
  if (!text || !selectedChatId) return;
  document.getElementById('thread-send-error').classList.add('hidden');
  wsSend({ type: 'send-chat-reply', conversationId: selectedChatId, text });
  textEl.value = '';
});

// ---- Forgot password (from the login screen, before signing in) ----

document.getElementById('btn-forgot-password').addEventListener('click', () => {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('forgot-password-form').classList.remove('hidden');
  document.getElementById('forgot-password-status').classList.add('hidden');
  document.getElementById('forgot-password-name').value = '';
});

document.getElementById('btn-back-to-login').addEventListener('click', () => {
  document.getElementById('forgot-password-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
});

document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('forgot-password-status');
  const btn = document.getElementById('forgot-password-submit');
  const name = document.getElementById('forgot-password-name').value.trim();
  if (!name) return;
  btn.disabled = true;
  try {
    await fetch('/api/agent/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    statusEl.textContent = 'Request sent. An admin will set you a new password shortly.';
    statusEl.classList.remove('hidden');
    document.getElementById('forgot-password-name').value = '';
  } catch {
    statusEl.textContent = 'Could not reach the server. Please try again.';
    statusEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ---- Change password (from the dashboard, while signed in) ----

document.getElementById('btn-open-change-password').addEventListener('click', () => {
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new').value = '';
  document.getElementById('cp-confirm').value = '';
  document.getElementById('change-password-error').classList.add('hidden');
  document.getElementById('change-password-success').classList.add('hidden');
  document.getElementById('change-password-modal').classList.remove('hidden');
});

document.getElementById('btn-cancel-change-password').addEventListener('click', () => {
  document.getElementById('change-password-modal').classList.add('hidden');
});

document.getElementById('change-password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const errEl = document.getElementById('change-password-error');
  const okEl = document.getElementById('change-password-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  const currentPassword = document.getElementById('cp-current').value;
  const newPassword = document.getElementById('cp-new').value;
  const confirmPassword = document.getElementById('cp-confirm').value;
  if (!currentPassword || !newPassword) {
    errEl.textContent = 'Both fields are required.';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPassword !== confirmPassword) {
    errEl.textContent = 'New passwords do not match.';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPassword.length < 4) {
    errEl.textContent = 'New password must be at least 4 characters.';
    errEl.classList.remove('hidden');
    return;
  }
  pendingChangePasswordNew = newPassword;
  wsSend({ type: 'change-password', currentPassword, newPassword });
});

document.getElementById('btn-sign-out').addEventListener('click', () => {
  if (currentCallId) wsSend({ type: 'end-call', callId: currentCallId });
  signedOutIntentionally = true;
  clearTimeout(reconnectTimer);
  sessionStorage.removeItem(STORAGE_KEY);
  try { if (ws) ws.close(); } catch { /* ignore */ }
  location.reload();
});

// ---- Restore a session after a page refresh, if one was saved ----

const storedAgentPassword = sessionStorage.getItem(STORAGE_KEY);
if (storedAgentPassword) {
  connectWS(storedAgentPassword);
}
