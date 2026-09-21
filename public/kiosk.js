'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Production note: add a TURN server here too — STUN alone will fail to
  // connect guests/agents behind symmetric NATs or strict hotel firewalls.
  // { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' },
];

const WAIT_WARNING_MS = 60 * 1000;
const IDLE_RESET_MS = 4000;

const screens = {};
document.querySelectorAll('.screen').forEach((el) => (screens[el.id] = el));
function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
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

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=guest`);

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (screens['screen-call'].classList.contains('active') ||
        screens['screen-waiting'].classList.contains('active')) {
      showError('Connection lost', 'We lost the connection to the front desk. Please try again.');
      cleanupCall();
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'queued':
      showScreen('screen-waiting');
      document.getElementById('waiting-topic').textContent = currentTopic;
      waitStartedAt = Date.now();
      startWaitTimer();
      break;

    case 'call-accepted':
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

    case 'call-ended':
      const reasonText = {
        'agent-ended': 'The agent ended the call.',
        'agent-disconnected': 'The agent lost connection. Please try again.',
      }[msg.reason] || 'We hope we could help. Have a great stay.';
      document.getElementById('ended-message').textContent = reasonText;
      cleanupCall();
      showScreen('screen-ended');
      setTimeout(resetToIdle, IDLE_RESET_MS);
      break;
  }
}

async function handleSignal(signalType, data) {
  if (!pc) return;
  if (signalType === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data));
  } else if (signalType === 'ice') {
    try { await pc.addIceCandidate(data); } catch (e) { console.warn('ICE add failed', e); }
  }
}

async function startPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.ontrack = (evt) => {
    document.getElementById('remote-video').srcObject = evt.streams[0];
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) wsSend({ type: 'signal', signalType: 'ice', data: evt.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      console.warn('Peer connection', pc.connectionState);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: 'signal', signalType: 'offer', data: offer });
}

async function requestMediaAndJoin(topic) {
  currentTopic = topic;
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

  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) await connectWS();
    wsSend({ type: 'join-queue', topic });
  } catch {
    showError('Can’t reach the front desk', 'Please try again in a moment.');
  }
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
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  micOn = true; camOn = true;
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
document.querySelectorAll('.dept-btn').forEach((btn) => {
  btn.addEventListener('click', () => requestMediaAndJoin(btn.dataset.topic));
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
  wsSend({ type: 'hangup' });
  cleanupCall();
  resetToIdle();
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

showScreen('screen-idle');
connectWS().catch(() => {}); // pre-connect so the queue join is instant
