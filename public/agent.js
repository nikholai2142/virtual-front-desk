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
let currentCallId = null;
let currentTopic = null;
let currentKioskId = null;
let callStartedAt = null;
let callTimerHandle = null;
let noteDebounce = null;
let knownQueueIds = new Set();
let micOn = true;
let camOn = true;
let chatConversations = new Map(); // conversationId -> conversation
let selectedChatId = null;
let connectTimeoutHandle = null;
const CONNECT_TIMEOUT_MS = 15 * 1000; // see kiosk.js for why this exists

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

function connectWS(password) {
  loginInProgress = true;
  lastLoginPassword = password;
  setLoginBusy(true);
  document.getElementById('login-error').classList.add('hidden');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws?role=agent`);
  } catch {
    showLoginError('Could not start a connection. Check the URL and try again.');
    return;
  }
  ws = socket;

  clearTimeout(loginTimeoutHandle);
  loginTimeoutHandle = setTimeout(() => {
    if (loginInProgress) {
      showLoginError('No response from the server after 20s. If this app was asleep it can take up to a minute to wake up — try again.');
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
    if (loginInProgress) showLoginError('Connection error. Please try again.');
  });

  socket.addEventListener('close', () => {
    if (loginInProgress) {
      showLoginError('Connection closed before signing in. Please try again.');
    } else if (screens['screen-dashboard'].classList.contains('active')) {
      document.getElementById('agent-status-dot').style.background = '#e5484d';
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
      sessionStorage.setItem(STORAGE_KEY, lastLoginPassword);
      document.getElementById('agent-name-label').textContent = msg.name;
      showScreen('screen-dashboard');
      wsSend({ type: 'get-log' });
      wsSend({ type: 'get-chats' });
      break;

    case 'agent-login-fail':
      sessionStorage.removeItem(STORAGE_KEY);
      showLoginError('Incorrect password. Try again.');
      break;

    case 'queue-update':
      renderQueue(msg.queue);
      break;

    case 'answer-failed':
      alert('That call was already answered by another agent.');
      break;

    case 'call-assigned':
      currentCallId = msg.callId;
      currentTopic = msg.topic;
      currentKioskId = msg.kioskId;
      startAsAnswerer();
      break;

    case 'signal':
      handleSignal(msg.signalType, msg.data);
      break;

    case 'call-log':
      renderCallLog(msg.entries);
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

  const newIds = new Set(queue.map((q) => q.callId));
  const hasNew = [...newIds].some((id) => !knownQueueIds.has(id));
  if (hasNew && knownQueueIds.size > 0) beep();
  knownQueueIds = newIds;

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
    div.innerHTML = `<strong>${escapeHtml(e.topic)}</strong>${kioskPart} · ${e.agentName || '—'}<br>${time} · ${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}`;
    box.appendChild(div);
  });
}

async function startAsAnswerer() {
  document.getElementById('call-topic-label').textContent = currentKioskId ? `${currentTopic} · ${currentKioskId}` : currentTopic;
  document.getElementById('no-call-placeholder').classList.add('hidden');
  document.getElementById('active-call').classList.remove('hidden');
  document.getElementById('call-notes').value = '';

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
    document.getElementById('remote-video').srcObject = evt.streams[0];
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
  clearTimeout(connectTimeoutHandle);
  pendingIceCandidates = [];
  pendingSignals = [];
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  clearInterval(callTimerHandle);
  callTimerHandle = null;
  currentCallId = null;
  currentTopic = null;
  currentKioskId = null;
  micOn = true; camOn = true;
  document.getElementById('active-call').classList.add('hidden');
  document.getElementById('no-call-placeholder').classList.remove('hidden');
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
  sessionStorage.removeItem(STORAGE_KEY);
  try { if (ws) ws.close(); } catch { /* ignore */ }
  location.reload();
});

// ---- Restore a session after a page refresh, if one was saved ----

const storedAgentPassword = sessionStorage.getItem(STORAGE_KEY);
if (storedAgentPassword) {
  connectWS(storedAgentPassword);
}
