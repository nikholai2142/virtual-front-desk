'use strict';

const REFRESH_INTERVAL_MS = 10000;
// sessionStorage (not localStorage): survives a page refresh, but clears
// when the tab/window closes — matches "stay signed in for this session"
// without leaving the password sitting around indefinitely on a shared
// front-desk computer. This is a plaintext admin password either way,
// consistent with how it's already handled elsewhere in this demo-grade app.
const STORAGE_KEY = 'vfd_admin_password';

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

/** Renders a 1-5 star rating as filled/empty star glyphs, e.g. "★★★★☆". */
function starGlyphs(stars) {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
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

/**
 * Tries to sign in with the given password (validated against the server,
 * same as before). Used both for the login form and to silently restore a
 * session on page load. Returns true/false so callers can react.
 */
async function attemptLogin(password, { silent = false } = {}) {
  adminPassword = password;
  try {
    await api('/api/admin/agents'); // just to validate the password
    sessionStorage.setItem(STORAGE_KEY, password);
    setLoginBusy(false);
    showScreen('screen-dashboard');
    startDashboard();
    return true;
  } catch (err) {
    adminPassword = null;
    sessionStorage.removeItem(STORAGE_KEY);
    if (!silent) {
      if (err.status === 401) showLoginError('Incorrect password.');
      else showLoginError('Could not reach the server. Please try again.');
    } else {
      setLoginBusy(false);
    }
    return false;
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('login-error').classList.add('hidden');
  const password = document.getElementById('login-password').value;
  if (!password) return;
  setLoginBusy(true);
  await attemptLogin(password);
});

document.getElementById('btn-sign-out').addEventListener('click', () => {
  sessionStorage.removeItem(STORAGE_KEY);
  location.reload();
});

// ---- Dashboard ----

function startDashboard() {
  refreshAll();
  loadHoldConfig();
  clearInterval(refreshHandle);
  refreshHandle = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

document.getElementById('btn-refresh').addEventListener('click', refreshAll);

async function refreshAll() {
  try {
    const [agentsData, statsData, resetData] = await Promise.all([
      api('/api/admin/agents'),
      api('/api/admin/stats'),
      api('/api/admin/password-reset-requests'),
    ]);
    renderAgents(agentsData.agents);
    renderStats(statsData);
    renderResetRequests(resetData.requests);
  } catch (err) {
    if (err.status === 401) {
      clearInterval(refreshHandle);
      adminPassword = null;
      sessionStorage.removeItem(STORAGE_KEY);
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
      <div><span class="agent-name">${escapeHtml(a.name)}</span><span class="agent-secret">Password ${escapeHtml(a.password)}</span></div>
      <button data-id="${escapeHtml(a.id)}">Remove</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Remove agent "${a.name}"?`)) return;
      try {
        const result = await api(`/api/admin/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
        warnIfNotPersisted(result);
        refreshAll();
      } catch (err) {
        alert('Could not remove agent: ' + err.message);
      }
    });
    list.appendChild(row);
  });
}

function renderResetRequests(requests) {
  const badge = document.getElementById('reset-requests-badge');
  if (requests.length > 0) {
    badge.textContent = requests.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const list = document.getElementById('reset-requests-list');
  if (!requests.length) {
    list.innerHTML = '<p class="empty-note">No pending requests.</p>';
    return;
  }
  list.innerHTML = '';
  requests.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'reset-request-row';
    const when = new Date(r.requestedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

    if (r.agentId) {
      row.innerHTML = `
        <div><span class="agent-name">${escapeHtml(r.name)}</span><span class="agent-secret">requested ${when}</span></div>
        <div class="reset-request-actions">
          <input type="text" class="reset-new-password" placeholder="New password" maxlength="60" />
          <button type="button" class="btn-small btn-set">Set</button>
          <button type="button" class="btn-dismiss">Dismiss</button>
        </div>
      `;
      row.querySelector('.btn-set').addEventListener('click', async () => {
        const input = row.querySelector('.reset-new-password');
        const newPassword = input.value.trim();
        if (!newPassword || newPassword.length < 4) {
          alert('Enter a new password of at least 4 characters.');
          return;
        }
        try {
          const result = await api(`/api/admin/password-reset-requests/${encodeURIComponent(r.id)}/resolve`, {
            method: 'POST',
            body: JSON.stringify({ newPassword }),
          });
          warnIfNotPersisted(result);
          refreshAll();
        } catch (err) {
          alert('Could not set the new password: ' + err.message);
        }
      });
    } else {
      row.innerHTML = `
        <div><span class="agent-name">${escapeHtml(r.name)}</span><span class="agent-secret">requested ${when} · no matching agent on file</span></div>
        <div class="reset-request-actions">
          <button type="button" class="btn-dismiss">Dismiss</button>
        </div>
      `;
    }

    row.querySelector('.btn-dismiss').addEventListener('click', async () => {
      if (!confirm(`Dismiss the password reset request from "${r.name}"?`)) return;
      try {
        await api(`/api/admin/password-reset-requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        refreshAll();
      } catch (err) {
        alert('Could not dismiss the request: ' + err.message);
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
    const holdPart = s.totalHoldCount
      ? ` · <span class="stats-hold">on hold ${formatDuration(s.totalHoldSeconds)} (${s.totalHoldCount}×)</span>`
      : '';
    const ratingPart = s.ratingCount
      ? ` · <span class="stats-rating">${starGlyphs(s.avgRating)} ${s.avgRating.toFixed(1)} (${s.ratingCount})</span>`
      : '';
    row.innerHTML = `
      <div class="stats-row-top">
        <span class="name">${escapeHtml(s.agentName)}</span>
        <span class="meta">${s.calls} call${s.calls === 1 ? '' : 's'}</span>
      </div>
      <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${pct}%"></div></div>
      <div class="stats-detail">
        avg ${formatDuration(s.avgTalkSeconds)} · total ${formatDuration(s.totalTalkSeconds)}
        ${s.topKiosk ? ` · mostly ${escapeHtml(s.topKiosk)}` : ''} · last call ${lastCall}${holdPart}${ratingPart}
      </div>
    `;
    if (s.agentId) {
      row.title = 'Click for full call history';
      row.addEventListener('click', () => openAgentDetail(s.agentId));
    } else {
      row.style.cursor = 'default';
      row.title = 'This agent has been removed — no detail view available';
    }
    table.appendChild(row);
  });
}

// ---- Agent detail (full call history + recordings) ----

async function openAgentDetail(agentId) {
  const modal = document.getElementById('agent-detail-modal');
  document.getElementById('agent-detail-name').textContent = 'Loading…';
  document.getElementById('agent-detail-totals').innerHTML = '';
  document.getElementById('agent-detail-calls').innerHTML = '';
  modal.classList.remove('hidden');
  try {
    const data = await api(`/api/admin/agents/${encodeURIComponent(agentId)}/detail`);
    renderAgentDetail(data);
  } catch (err) {
    document.getElementById('agent-detail-name').textContent = 'Could not load';
    document.getElementById('agent-detail-calls').innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
  }
}

function renderAgentDetail(data) {
  document.getElementById('agent-detail-name').textContent = data.agent.name;

  const t = data.totals;
  const totalsEl = document.getElementById('agent-detail-totals');
  totalsEl.innerHTML = `
    <span><strong>${t.calls}</strong> call${t.calls === 1 ? '' : 's'}</span>
    <span>avg <strong>${formatDuration(t.avgTalkSeconds)}</strong></span>
    <span>total talk <strong>${formatDuration(t.totalTalkSeconds)}</strong></span>
    <span>hold time <strong>${formatDuration(t.totalHoldSeconds)}</strong>${t.totalHoldCount ? ` (${t.totalHoldCount}×)` : ''}</span>
    ${t.topKiosk ? `<span>mostly <strong>${escapeHtml(t.topKiosk)}</strong></span>` : ''}
    <span>rating ${t.ratingCount ? `<strong>${starGlyphs(t.avgRating)} ${t.avgRating.toFixed(1)}</strong> (${t.ratingCount})` : '<strong>no ratings yet</strong>'}</span>
  `;

  const callsEl = document.getElementById('agent-detail-calls');
  if (!data.calls.length) {
    callsEl.innerHTML = '<p class="empty-note">No calls yet.</p>';
    return;
  }
  callsEl.innerHTML = '';
  data.calls.forEach((c) => {
    const dur = Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000));
    const when = new Date(c.answeredAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const kioskPart = c.kioskId ? ` · ${escapeHtml(c.kioskId)}` : '';
    const holdPart = c.holdSeconds ? ` · on hold ${formatDuration(c.holdSeconds)}` : '';
    const notesPart = c.notes ? `<div class="acr-notes">"${escapeHtml(c.notes)}"</div>` : '';
    const recordingPart = c.recording
      ? `<div class="agent-call-recording"><a href="${escapeHtml(c.recording.url)}" target="_blank" rel="noopener">▶ Play recording</a><span class="rec-size">${formatBytes(c.recording.bytes)}</span></div>`
      : '';
    const ratingPart = c.rating
      ? `<div class="agent-call-rating"><span class="acr-stars">${starGlyphs(c.rating.stars)}</span>${c.rating.guestName ? ` <span class="acr-rater">— ${escapeHtml(c.rating.guestName)}</span>` : ''}${c.rating.remarks ? `<div class="acr-notes">"${escapeHtml(c.rating.remarks)}"</div>` : ''}</div>`
      : '';
    const row = document.createElement('div');
    row.className = 'agent-call-row';
    row.innerHTML = `
      <div class="acr-top"><span>${escapeHtml(c.topic)}${kioskPart}</span><span>${when}</span></div>
      <div>${formatDuration(dur)}${holdPart}</div>
      ${notesPart}${recordingPart}${ratingPart}
    `;
    callsEl.appendChild(row);
  });
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

document.getElementById('btn-close-agent-detail').addEventListener('click', () => {
  document.getElementById('agent-detail-modal').classList.add('hidden');
});
document.getElementById('agent-detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'agent-detail-modal') e.currentTarget.classList.add('hidden');
});

// ---- Video call configuration (max hold duration) ----

async function loadHoldConfig() {
  try {
    const data = await api('/api/admin/config');
    document.getElementById('hold-config-max-seconds').value = data.config.maxHoldSeconds;
    document.getElementById('hold-config-max-seconds').min = data.min;
    document.getElementById('hold-config-max-seconds').max = data.max;
    updateHoldConfigPreview();
  } catch { /* leave the field blank rather than interrupting the dashboard load */ }
}

function updateHoldConfigPreview() {
  const val = Number(document.getElementById('hold-config-max-seconds').value);
  const preview = document.getElementById('hold-config-preview');
  if (!Number.isFinite(val) || val <= 0) { preview.textContent = ''; return; }
  preview.textContent = `= ${formatDuration(val)}`;
}
document.getElementById('hold-config-max-seconds').addEventListener('input', updateHoldConfigPreview);

document.getElementById('hold-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('hold-config-error');
  const okEl = document.getElementById('hold-config-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  const maxHoldSeconds = Number(document.getElementById('hold-config-max-seconds').value);
  try {
    const result = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ maxHoldSeconds }) });
    warnIfNotPersisted(result);
    okEl.textContent = 'Saved. Applies to holds started from now on.';
    okEl.classList.remove('hidden');
    setTimeout(() => okEl.classList.add('hidden'), 2500);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

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
  const password = document.getElementById('new-agent-password').value.trim();
  if (!name || !password) {
    errEl.textContent = 'Both name and password are required.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const result = await api('/api/admin/agents', { method: 'POST', body: JSON.stringify({ name, password }) });
    document.getElementById('new-agent-name').value = '';
    document.getElementById('new-agent-password').value = '';
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

// ---- Change admin password ----

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

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
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
  try {
    const result = await api('/api/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    adminPassword = newPassword; // keep this session authenticated under the new password
    sessionStorage.setItem(STORAGE_KEY, newPassword);
    warnIfNotPersisted(result);
    okEl.textContent = 'Password updated.';
    okEl.classList.remove('hidden');
    setTimeout(() => document.getElementById('change-password-modal').classList.add('hidden'), 1000);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---- Restore a session after a page refresh, if one was saved ----

const storedAdminPassword = sessionStorage.getItem(STORAGE_KEY);
if (storedAdminPassword) {
  setLoginBusy(true);
  attemptLogin(storedAdminPassword, { silent: true });
} else {
  showScreen('screen-login');
}
