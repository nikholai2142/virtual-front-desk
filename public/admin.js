'use strict';

const REFRESH_INTERVAL_MS = 10000;

let adminPassword = null;
let refreshHandle = null;

const screens = {};
document.querySelectorAll('.screen').forEach((el) => (screens[el.id] = el));
function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'X-Admin-Password': adminPassword,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---- Login ----

function setLoginBusy(busy) {
  const btn = document.getElementById('login-submit');
  btn.disabled = busy;
  btn.textContent = busy ? 'Signing in…' : 'Sign In';
}

function showLoginError(text) {
  setLoginBusy(false);
  const el = document.getElementById('login-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('login-error').classList.add('hidden');
  const password = document.getElementById('login-password').value;
  if (!password) return;
  setLoginBusy(true);
  adminPassword = password;
  try {
    await api('/api/admin/agents'); // just to validate the password
    setLoginBusy(false);
    showScreen('screen-dashboard');
    startDashboard();
  } catch (err) {
    adminPassword = null;
    if (err.status === 401) showLoginError('Incorrect password.');
    else showLoginError('Could not reach the server. Please try again.');
  }
});

// ---- Dashboard ----

function startDashboard() {
  refreshAll();
  clearInterval(refreshHandle);
  refreshHandle = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

document.getElementById('btn-refresh').addEventListener('click', refreshAll);

async function refreshAll() {
  try {
    const [agentsData, statsData] = await Promise.all([
      api('/api/admin/agents'),
      api('/api/admin/stats'),
    ]);
    renderAgents(agentsData.agents);
    renderStats(statsData);
  } catch (err) {
    if (err.status === 401) {
      clearInterval(refreshHandle);
      adminPassword = null;
      showScreen('screen-login');
      showLoginError('Session ended. Please sign in again.');
    }
    // Other errors (e.g. a transient network blip) are left to the next
    // scheduled refresh rather than interrupting the admin with an alert.
  }
}

function renderAgents(agents) {
  const list = document.getElementById('agents-list');
  if (!agents.length) {
    list.innerHTML = '<p class="empty-note">No agents configured.</p>';
    return;
  }
  list.innerHTML = '';
  agents.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.innerHTML = `
      <div><span class="agent-name">${escapeHtml(a.name)}</span><span class="agent-pin">PIN ${escapeHtml(a.pin)}</span></div>
      <button data-pin="${escapeHtml(a.pin)}">Remove</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Remove agent "${a.name}"?`)) return;
      try {
        const result = await api(`/api/admin/agents/${encodeURIComponent(a.pin)}`, { method: 'DELETE' });
        warnIfNotPersisted(result);
        refreshAll();
      } catch (err) {
        alert('Could not remove agent: ' + err.message);
      }
    });
    list.appendChild(row);
  });
}

function renderStats(data) {
  const totals = data.totals;
  document.getElementById('totals-summary').textContent =
    `${totals.agentsOnline} online · ${totals.guestsWaiting} waiting · ${totals.activeCalls} on a call`;
  document.getElementById('stats-note').textContent = data.note;

  const table = document.getElementById('stats-table');
  const stats = data.agents;
  if (!stats.length) {
    table.innerHTML = '<p class="empty-note">No agents yet.</p>';
    return;
  }
  const maxCalls = Math.max(1, ...stats.map((s) => s.calls));
  table.innerHTML = '';
  stats.forEach((s) => {
    const pct = Math.round((s.calls / maxCalls) * 100);
    const row = document.createElement('div');
    row.className = 'stats-row';
    const lastCall = s.lastCallAt ? new Date(s.lastCallAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'never';
    row.innerHTML = `
      <div class="stats-row-top">
        <span class="name">${escapeHtml(s.agentName)}</span>
        <span class="meta">${s.calls} call${s.calls === 1 ? '' : 's'}</span>
      </div>
      <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${pct}%"></div></div>
      <div class="stats-detail">
        avg ${formatDuration(s.avgTalkSeconds)} · total ${formatDuration(s.totalTalkSeconds)}
        ${s.topTopic ? ` · mostly ${escapeHtml(s.topTopic)}` : ''} · last call ${lastCall}
      </div>
    `;
    table.appendChild(row);
  });
}

function formatDuration(totalSeconds) {
  if (!totalSeconds) return '0:00';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---- Add agent ----

document.getElementById('add-agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('add-agent-error');
  errEl.classList.add('hidden');
  const name = document.getElementById('new-agent-name').value.trim();
  const pin = document.getElementById('new-agent-pin').value.trim();
  if (!name || !pin) {
    errEl.textContent = 'Both name and PIN are required.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const result = await api('/api/admin/agents', { method: 'POST', body: JSON.stringify({ name, pin }) });
    document.getElementById('new-agent-name').value = '';
    document.getElementById('new-agent-pin').value = '';
    warnIfNotPersisted(result);
    refreshAll();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// If persistent storage IS set up but this particular save didn't reach it
// (a transient Redis/network hiccup), say so — otherwise the admin has no
// way to know the change might not survive a restart.
function warnIfNotPersisted(result) {
  if (result && result.persistenceConfigured && result.persisted === false) {
    alert('Saved for now, but could not reach persistent storage — this change may be lost if the server restarts. Check the Upstash database and try again shortly.');
  }
}

showScreen('screen-login');
