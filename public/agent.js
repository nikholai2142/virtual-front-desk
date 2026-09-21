'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Production note: add a TURN server here too — see kiosk.js for why.
];

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
let callStartedAt = null;
let callTimerHandle = null;
let noteDebounce = null;
let knownQueueIds = new Set();
let micOn = true;
let camOn = true;

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

const LOGIN_TIMEOUT_MS = 20000; // Render free-tier cold starts can take ~30-60s;
                                 // this at least turns a silent hang into a visible message.
let loginInProgress = false;
let loginTimeoutHandle = null;

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

function connectWS(pin) {
  loginInProgress = true;
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
    socket.send(JSON.stringify({ type: 'agent-login', pin }));
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
      document.getElementById('agent-name-label').textContent = msg.name;
      showScreen('screen-dashboard');
      wsSend({ type: 'get-log' });
      break;

    case 'agent-login-fail':
      showLoginError('Incorrect PIN. Try again.');
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
      startAsAnswerer();
      break;

    case 'signal':
      handleSignal(msg.signalType, msg.data);
      break;

    case 'call-log':
      renderCallLog(msg.entries);
      break;

    case 'call-ended':
      if (msg.callId === currentCallId || currentCallId) {
        endActiveCallUI();
        wsSend({ type: 'get-log' });
      }
      break;
  }
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
      <div class="qi-top"><strong>${escapeHtml(item.topic)}</strong></div>
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
    div.innerHTML = `<strong>${escapeHtml(e.topic)}</strong> · ${e.agentName || '—'}<br>${time} · ${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}`;
    box.appendChild(div);
  });
}

async function startAsAnswerer() {
  document.getElementById('call-topic-label').textContent = currentTopic;
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

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (evt) => {
    document.getElementById('remote-video').srcObject = evt.streams[0];
  };
  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      wsSend({ type: 'signal', callId: currentCallId, signalType: 'ice', data: evt.candidate });
    }
  };

  callStartedAt = Date.now();
  callTimerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    document.getElementById('call-timer-label').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

async function handleSignal(signalType, data) {
  if (!pc) return;
  if (signalType === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'signal', callId: currentCallId, signalType: 'answer', data: answer });
  } else if (signalType === 'ice') {
    try { await pc.addIceCandidate(data); } catch (e) { console.warn('ICE add failed', e); }
  }
}

function endActiveCallUI() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  clearInterval(callTimerHandle);
  callTimerHandle = null;
  currentCallId = null;
  currentTopic = null;
  micOn = true; camOn = true;
  document.getElementById('active-call').classList.add('hidden');
  document.getElementById('no-call-placeholder').classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- UI wiring ----
document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('login-error').classList.add('hidden');
  const pin = document.getElementById('login-pin').value.trim();
  if (!pin) return;
  connectWS(pin);
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
