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

// ---- Admin page navigation (Dashboard / Agent Performance / User Management / Configuration) ----
// Sign-in and the dashboard shell (topbar + nav) stay as they were; what
// used to be one long scrolling page is now four, switched by the nav bar
// below the topbar. Dashboard is the default landing page after sign-in.
const adminPages = {};
document.querySelectorAll('.admin-page').forEach((el) => (adminPages[el.id] = el));
let currentAdminPage = 'page-overview';

function showAdminPage(pageId) {
  if (!adminPages[pageId]) return;
  currentAdminPage = pageId;
  Object.values(adminPages).forEach((el) => el.classList.remove('active'));
  adminPages[pageId].classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
  // The dashboard's chart/stats only need loading when the page is actually
  // shown — everything else is already kept fresh by refreshAll()'s poll.
  if (pageId === 'page-overview' && adminPassword) loadOverview();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showAdminPage(btn.dataset.page));
});

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
  showAdminPage('page-overview'); // also triggers the first loadOverview()
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
    renderPerfCharts(statsData.agents);
    renderResetRequests(resetData.requests);
    // The dashboard's own filtered view only needs refreshing while it's
    // actually the visible page — no point re-fetching and re-drawing a
    // chart nobody's looking at every 10 seconds.
    if (currentAdminPage === 'page-overview') loadOverview();
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
  const navBadge = document.getElementById('nav-users-badge');
  if (requests.length > 0) {
    badge.textContent = requests.length;
    badge.classList.remove('hidden');
    navBadge.textContent = requests.length;
    navBadge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    navBadge.classList.add('hidden');
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

// ---- Charts (hand-rolled SVG bar charts — no charting library, matching
// the rest of this project's zero-dependency approach) ----

/** Rounds a value up to a "clean" axis ceiling (1/2/5 × a power of ten), e.g. 34 -> 50. */
function niceCeil(max) {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  let niceNorm;
  if (norm <= 1) niceNorm = 1;
  else if (norm <= 2) niceNorm = 2;
  else if (norm <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * base;
}

/** An SVG path for a bar rounded only at its data-end (top), square at the baseline. */
function roundedTopBarPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.max(0, Math.min(r, w / 2, h));
  const bottom = y + h;
  if (r === 0) return `M${x},${bottom} L${x},${y} L${x + w},${y} L${x + w},${bottom} Z`;
  return `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} Z`;
}

/**
 * Renders a single-series column chart into `container` (an empty div).
 * `buckets` is [{ label, value, ...anything else the caller wants to carry
 * through to onBarClick }]. One hue throughout — these are all magnitude-
 * by-category charts (calls per day, calls per agent, rating per agent),
 * never multiple series, so there's no legend and no per-bar color coding;
 * identity comes from the axis labels. The max bar gets a direct value
 * label, every other value lives in the hover/focus tooltip — same data,
 * just not shouted at the reader all at once.
 */
function renderColumnChart(container, buckets, opts) {
  const {
    color,
    valueFormat = (v) => String(v),
    tickFormat = (v) => String(Math.round(v)),
    maxValueOverride,
    ariaLabel = 'Chart',
    emptyText = 'No data.',
    onBarClick,
  } = opts;

  if (!buckets.length || buckets.every((b) => b.value === 0)) {
    container.innerHTML = `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
    return;
  }

  const width = 960;
  const height = 220;
  const padTop = 26;
  const padBottom = 30;
  const padLeft = 4;
  const padRight = 4;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const dataMax = Math.max(...buckets.map((b) => b.value));
  const maxVal = maxValueOverride || niceCeil(dataMax);
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(24, slot - 4));
  const radius = Math.min(4, barW / 2);
  const maxIndex = buckets.reduce((best, b, i) => (b.value > buckets[best].value ? i : best), 0);
  const ticks = [0, maxVal / 2, maxVal];
  const labelEvery = Math.max(1, Math.ceil(n / 14));

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="${escapeHtml(ariaLabel)}" preserveAspectRatio="none">`;

  let lastTickLabel = null;
  for (const t of ticks) {
    const y = padTop + plotH - (maxVal ? (t / maxVal) * plotH : 0);
    svg += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" class="chart-grid" />`;
    // On a very small-scale chart (e.g. max value 1), rounding can make two
    // distinct ticks (0.5 and 1) format to the same text ("1" and "1") —
    // skip the duplicate label rather than print the same number twice.
    const label = tickFormat(t);
    if (label !== lastTickLabel) {
      svg += `<text x="${padLeft}" y="${(y - 4).toFixed(1)}" class="chart-tick">${escapeHtml(label)}</text>`;
      lastTickLabel = label;
    }
  }

  buckets.forEach((b, i) => {
    const slotX = padLeft + i * slot;
    const barX = slotX + (slot - barW) / 2;
    const h = maxVal ? (b.value / maxVal) * plotH : 0;
    const barY = padTop + plotH - h;
    svg += `<g class="chart-bar-group" tabindex="0" data-index="${i}">`;
    svg += `<rect x="${slotX.toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${plotH}" class="chart-hit" />`;
    if (h > 0) {
      svg += `<path d="${roundedTopBarPath(barX, barY, barW, h, radius)}" class="chart-bar" fill="${color}" />`;
    }
    if (i === maxIndex && b.value > 0) {
      svg += `<text x="${(barX + barW / 2).toFixed(1)}" y="${(barY - 8).toFixed(1)}" class="chart-value-label" text-anchor="middle">${escapeHtml(valueFormat(b.value))}</text>`;
    }
    svg += `</g>`;
  });

  buckets.forEach((b, i) => {
    if (i % labelEvery !== 0 && i !== n - 1) return;
    const x = padLeft + i * slot + slot / 2;
    svg += `<text x="${x.toFixed(1)}" y="${height - padBottom + 16}" class="chart-axis-label" text-anchor="middle">${escapeHtml(b.label)}</text>`;
  });

  svg += `</svg><div class="chart-tooltip hidden"></div>`;
  container.innerHTML = svg;

  const tooltip = container.querySelector('.chart-tooltip');
  container.querySelectorAll('.chart-bar-group').forEach((g) => {
    const idx = Number(g.dataset.index);
    const bucket = buckets[idx];
    const show = () => {
      tooltip.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = valueFormat(bucket.value);
      const span = document.createElement('span');
      span.textContent = ' · ' + bucket.label;
      tooltip.appendChild(strong);
      tooltip.appendChild(span);
      tooltip.classList.remove('hidden');
      const pct = (idx + 0.5) / n;
      tooltip.style.left = `${(pct * container.clientWidth).toFixed(0)}px`;
      g.querySelector('.chart-bar')?.classList.add('chart-bar-hover');
    };
    const hide = () => {
      tooltip.classList.add('hidden');
      g.querySelector('.chart-bar')?.classList.remove('chart-bar-hover');
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('pointerleave', hide);
    g.addEventListener('focus', show);
    g.addEventListener('blur', hide);
    if (onBarClick) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => onBarClick(bucket, idx));
      g.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); onBarClick(bucket, idx); }
      });
    }
  });
}

/** Calls-handled and average-rating bar charts on the Agent Performance page — one bar per agent, clicking either opens that agent's detail view. */
function renderPerfCharts(stats) {
  const sorted = [...stats].sort((a, b) => b.calls - a.calls);

  const callsBuckets = sorted.map((s) => ({ label: s.agentName, value: s.calls, agentId: s.agentId }));
  renderColumnChart(document.getElementById('perf-calls-chart'), callsBuckets, {
    color: 'var(--accent)',
    valueFormat: (v) => `${v} call${v === 1 ? '' : 's'}`,
    ariaLabel: 'Calls handled per agent',
    emptyText: 'No calls yet.',
    onBarClick: (b) => { if (b.agentId) openAgentDetail(b.agentId); },
  });

  const rated = sorted.filter((s) => s.ratingCount > 0);
  const ratingBuckets = rated.map((s) => ({ label: s.agentName, value: s.avgRating, agentId: s.agentId }));
  renderColumnChart(document.getElementById('perf-rating-chart'), ratingBuckets, {
    color: '#f6c76a',
    maxValueOverride: 5,
    valueFormat: (v) => `★ ${v.toFixed(1)}`,
    tickFormat: (v) => v.toFixed(1),
    ariaLabel: 'Average rating per agent',
    emptyText: 'No ratings yet.',
    onBarClick: (b) => { if (b.agentId) openAgentDetail(b.agentId); },
  });
}

// ---- Dashboard (filterable combined stats + calls-over-time chart) ----

let lastOverviewEntries = [];
let lastOverviewRange = { from: null, to: null };

function resolveDateRange() {
  const preset = document.getElementById('filter-range').value;
  const now = new Date();
  if (preset === 'custom') {
    const fromVal = document.getElementById('filter-from').value;
    const toVal = document.getElementById('filter-to').value;
    const from = fromVal ? new Date(`${fromVal}T00:00:00`).getTime() : null;
    const to = toVal ? new Date(`${toVal}T23:59:59.999`).getTime() : Date.now();
    return { from, to };
  }
  if (preset === 'all') return { from: null, to: null };
  if (preset === 'today') {
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), to: Date.now() };
  }
  if (preset === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: Date.now() };
  }
  const days = Number(preset);
  return { from: Date.now() - days * 86400000, to: Date.now() };
}

document.getElementById('filter-range').addEventListener('change', () => {
  const isCustom = document.getElementById('filter-range').value === 'custom';
  document.getElementById('filter-from-field').classList.toggle('hidden', !isCustom);
  document.getElementById('filter-to-field').classList.toggle('hidden', !isCustom);
  loadOverview();
});
['filter-from', 'filter-to', 'filter-agent', 'filter-kiosk'].forEach((id) => {
  document.getElementById(id).addEventListener('change', loadOverview);
});
document.getElementById('filter-groupby').addEventListener('change', renderCallsChartFromCache);

/** Fills the agent/kiosk filter <select>s from the endpoint's own filter option lists, preserving whatever the admin already had picked. */
function populateFilterOptions(filters) {
  const agentSel = document.getElementById('filter-agent');
  const kioskSel = document.getElementById('filter-kiosk');
  const prevAgent = agentSel.value;
  const prevKiosk = kioskSel.value;
  agentSel.innerHTML = '<option value="">All agents</option>' +
    filters.agents.map((a) => `<option value="${escapeHtml(a.value)}">${escapeHtml(a.label)}</option>`).join('');
  kioskSel.innerHTML = '<option value="">All kiosks</option>' +
    filters.kiosks.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
  if ([...agentSel.options].some((o) => o.value === prevAgent)) agentSel.value = prevAgent;
  if ([...kioskSel.options].some((o) => o.value === prevKiosk)) kioskSel.value = prevKiosk;
}

async function loadOverview() {
  const { from, to } = resolveDateRange();
  lastOverviewRange = { from, to };
  const agentId = document.getElementById('filter-agent').value;
  const kioskId = document.getElementById('filter-kiosk').value;
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  if (agentId) params.set('agentId', agentId);
  if (kioskId) params.set('kioskId', kioskId);
  try {
    const data = await api(`/api/admin/stats/overview?${params.toString()}`);
    populateFilterOptions(data.filters);
    document.getElementById('ov-note').textContent = data.note;
    renderOverviewTiles(data.totals);
    lastOverviewEntries = data.entries;
    renderCallsChartFromCache();
  } catch (err) {
    if (err.status === 401) return; // the next refreshAll() tick will handle bouncing back to sign-in
    console.warn('Could not load dashboard overview:', err);
  }
}

function renderOverviewTiles(t) {
  document.getElementById('ov-calls').textContent = t.calls;
  document.getElementById('ov-avg-talk').textContent = formatDuration(t.avgTalkSeconds);
  document.getElementById('ov-total-talk').textContent = formatDuration(t.totalTalkSeconds);
  document.getElementById('ov-hold').textContent = t.totalHoldCount ? `${formatDuration(t.totalHoldSeconds)} (${t.totalHoldCount}×)` : '0:00';
  document.getElementById('ov-rating').textContent = t.ratingCount ? `${starGlyphs(t.avgRating)} ${t.avgRating.toFixed(1)}` : '—';
}

/** Groups filtered call entries into day or month buckets spanning the resolved range (zero-filled, so gaps show as gaps, not a shorter chart). Bucketing happens in the admin's own browser timezone — the server only filters, it doesn't guess a timezone. */
function bucketEntries(entries, groupBy, from, to) {
  const counts = new Map();
  for (const e of entries) {
    const d = new Date(e.answeredAt);
    const key = groupBy === 'month'
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let start, end;
  if (Number.isFinite(from) && Number.isFinite(to)) {
    start = new Date(from);
    end = new Date(to);
  } else if (entries.length) {
    const times = entries.map((e) => e.answeredAt);
    start = new Date(Math.min(...times));
    end = new Date(Math.max(...times));
  } else {
    start = new Date();
    end = new Date();
  }

  const buckets = [];
  if (groupBy === 'month') {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    const endM = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cur <= endM) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({ key, label: cur.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), value: counts.get(key) || 0 });
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endD = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cur <= endD) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
      buckets.push({ key, label: cur.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), value: counts.get(key) || 0 });
      cur.setDate(cur.getDate() + 1);
    }
  }
  return buckets;
}

/** Re-buckets and redraws the "Calls over time" chart from the last-fetched entries — no refetch needed just to switch Day/Month grouping. */
function renderCallsChartFromCache() {
  let groupBy = document.getElementById('filter-groupby').value;
  const { from, to } = lastOverviewRange;
  let buckets = bucketEntries(lastOverviewEntries, groupBy, from, to);
  const noteEl = document.getElementById('ov-chart-note');
  if (groupBy === 'day' && buckets.length > 120) {
    // A daily bar per day over a multi-month range is unreadable — fall back
    // to month buckets automatically rather than rendering 200+ slivers.
    groupBy = 'month';
    buckets = bucketEntries(lastOverviewEntries, groupBy, from, to);
    noteEl.textContent = 'Showing by month — the selected range is too wide for a daily view.';
  } else {
    noteEl.textContent = '';
  }
  renderColumnChart(document.getElementById('calls-chart'), buckets, {
    color: 'var(--accent)',
    valueFormat: (v) => `${v} call${v === 1 ? '' : 's'}`,
    ariaLabel: 'Calls over time',
    emptyText: 'No calls in this range.',
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
