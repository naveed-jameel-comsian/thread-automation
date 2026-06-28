let state = null;
let accounts = [];
let filter = 'all';
let search = '';

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;

const els = {
  subtitle: document.getElementById('subtitle'),
  monitorBadge: document.getElementById('monitorBadge'),
  monitorStatus: document.getElementById('monitorStatus'),
  kpiRow: document.getElementById('kpiRow'),
  accountsTable: document.getElementById('accountsTable'),
  sourceAccounts: document.getElementById('sourceAccounts'),
  lastRepost: document.getElementById('lastRepost'),
  activityLog: document.getElementById('activityLog'),
  searchInput: document.getElementById('searchInput'),
  addAccountBtn: document.getElementById('addAccountBtn'),
  addAccountModal: document.getElementById('addAccountModal'),
  addAccountForm: document.getElementById('addAccountForm'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  cancelModalBtn: document.getElementById('cancelModalBtn'),
  tabAll: document.getElementById('tabAll'),
  tabAttention: document.getElementById('tabAttention'),
  tabLive: document.getElementById('tabLive'),
  remoteLoginModal: document.getElementById('remoteLoginModal'),
  remoteLoginTitle: document.getElementById('remoteLoginTitle'),
  closeRemoteLoginBtn: document.getElementById('closeRemoteLoginBtn'),
  remoteViewport: document.getElementById('remoteViewport'),
  remoteFrame: document.getElementById('remoteFrame'),
  remoteLoading: document.getElementById('remoteLoading'),
  remoteLoadingText: document.getElementById('remoteLoadingText'),
  saveSessionBtn: document.getElementById('saveSessionBtn'),
  remoteStatus: document.getElementById('remoteStatus'),
};

const remoteLogin = {
  username: null,
  profileId: null,
  socket: null,
  lastFrame: null,
  loggedIn: false,
  closing: false,
};

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatRelative(value) {
  if (!value) return '—';
  const diffMs = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return diffMs >= 0 ? `in ${mins}m` : `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return diffMs >= 0 ? `in ${hours}h` : `${hours}h`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `in ${days}d` : `${days}d`;
}

function formatMetric(value) {
  if (value === null || value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function initials(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}

function reachClass(reach) {
  if (reach === null || reach === undefined) return '';
  if (reach >= 70) return 'reach-good';
  if (reach >= 40) return 'reach-mid';
  return 'reach-low';
}

function getPostingAccounts() {
  if (accounts.length) return accounts;
  return Object.values(state?.postingAccounts || {});
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    if (res.ok) accounts = await res.json();
  } catch {
    // Keep last known list on error.
  }
}

async function loadState() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) state = await res.json();
  } catch {
    // Keep last known state on error.
  }
}

async function refreshDashboard() {
  await Promise.all([loadState(), loadAccounts()]);
  render();
}

function filterAccounts(accounts) {
  let list = accounts;

  if (search) {
    const q = search.toLowerCase();
    list = list.filter((a) =>
      a.username.toLowerCase().includes(q)
      || (a.displayName || '').toLowerCase().includes(q),
    );
  }

  if (filter === 'attention') {
    list = list.filter((a) => ['stalled', 'blocked', 'error', 'shadowban'].includes(a.status));
  } else if (filter === 'live') {
    list = list.filter((a) => a.postingEnabled && a.status === 'smooth' && !a.paused);
  }

  return list;
}

function renderKpis(summary) {
  const s = summary || {};
  els.kpiRow.innerHTML = `
    <div class="kpi running"><div class="kpi-label">Running</div><div class="kpi-value">${s.running ?? 0}</div></div>
    <div class="kpi at-risk"><div class="kpi-label">At risk</div><div class="kpi-value">${s.atRisk ?? 0}</div></div>
    <div class="kpi down"><div class="kpi-label">Down</div><div class="kpi-value">${s.down ?? 0}</div></div>
    <div class="kpi views"><div class="kpi-label">Views 24h</div><div class="kpi-value">${formatMetric(s.views24h)}</div></div>
    <div class="kpi follows"><div class="kpi-label">Net follows 24h</div><div class="kpi-value">${s.netFollows24h != null ? (s.netFollows24h >= 0 ? '+' : '') + formatMetric(s.netFollows24h) : '—'}</div></div>
    <div class="kpi failed"><div class="kpi-label">Failed 24h</div><div class="kpi-value">${s.failed24h ?? 0}</div></div>
  `;
}

function renderAccountsTable() {
  const accounts = filterAccounts(getPostingAccounts());

  if (!accounts.length) {
    els.accountsTable.innerHTML = `<tr><td colspan="11" class="empty">No posting accounts yet — click "+ Add account"</td></tr>`;
    return;
  }

  els.accountsTable.innerHTML = accounts.map((a) => {
    const status = a.paused ? 'paused' : (a.status || 'pending');
    const nextLate = a.nextPostAt && new Date(a.nextPostAt) < new Date();
    const delta = a.followerDelta;
    const deltaHtml = delta != null
      ? `<span class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${delta >= 0 ? '+' : ''}${delta}</span>`
      : '';

    return `
      <tr>
        <td>
          <div class="account-cell">
            <div class="avatar">${initials(a.username)}</div>
            <div>
              <div class="account-name">${a.displayName || a.username}</div>
              <div class="account-handle">@${a.username}</div>
            </div>
          </div>
        </td>
        <td><span class="status-pill status-${status}"><span class="status-dot"></span>${status}</span></td>
        <td class="${reachClass(a.reach)}">${a.reach != null ? `${a.reach}%` : '—'}</td>
        <td>${formatMetric(a.views24h)}</td>
        <td>${formatMetric(a.likes24h)}</td>
        <td>
          <div class="followers-cell">
            <span>${a.followers || '—'}</span>
            ${deltaHtml}
          </div>
        </td>
        <td>${formatRelative(a.lastPostAt)}</td>
        <td class="${nextLate ? 'late' : ''}">${a.nextPostAt ? (nextLate ? `${formatRelative(a.nextPostAt)} late` : formatRelative(a.nextPostAt)) : '—'}</td>
        <td>${a.postsToday ?? 0}</td>
        <td>
          <label class="toggle" title="${a.postingEnabled ? 'Posting enabled' : 'Posting disabled'}">
            <input type="checkbox" data-action="posting" data-username="${a.username}" ${a.postingEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" title="Remote login" data-action="login" data-username="${a.username}" data-profile-id="${a.kameleoProfileId || ''}">🔑</button>
            <button class="icon-btn" title="Remove" data-action="remove" data-username="${a.username}">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderSourceAccounts() {
  const sources = Object.values(state?.sourceAccounts || {});
  if (!sources.length) {
    els.sourceAccounts.innerHTML = '<div class="empty">No source accounts</div>';
    return;
  }

  els.sourceAccounts.innerHTML = sources.map((s) => `
    <div class="source-item">
      <strong>@${s.username}</strong>
      <div>Last post: ${formatRelative(s.lastPostAt)}</div>
      <div>Checked: ${formatRelative(s.lastCheckedAt)}</div>
      <div>Seen: ${s.totalSeenPosts ?? 0} posts</div>
    </div>
  `).join('');
}

function renderLastRepost() {
  const r = state?.lastRepost;
  if (!r) {
    els.lastRepost.className = 'empty';
    els.lastRepost.textContent = 'No reposts yet';
    return;
  }

  els.lastRepost.className = 'source-item';
  els.lastRepost.innerHTML = `
    <div><strong>${r.success ? 'Success' : 'Failed'}</strong> · ${formatTime(r.at)}</div>
    <div>From @${r.sourceUsername || '?'} → @${r.targetUsername || '?'}</div>
    <div>${(r.repostText || '').slice(0, 200)}${(r.repostText || '').length > 200 ? '...' : ''}</div>
  `;
}

function renderActivity() {
  const log = state?.activityLog || [];
  if (!log.length) {
    els.activityLog.innerHTML = '<div class="empty">No activity yet</div>';
    return;
  }

  els.activityLog.innerHTML = log.slice(0, 20).map((item) => `
    <div class="log-item">
      <div style="color:var(--muted);font-size:0.78rem">${formatTime(item.at)} · ${item.level}</div>
      <div>${item.message}</div>
    </div>
  `).join('');
}

function render() {
  const summary = state?.summary || {};
  const automationEnabled = state?.automationEnabled ?? false;
  const monitoredCount = state?.monitoredAccounts?.length || 0;
  const monitorStatus = state?.monitorStatus || 'connecting';

  const total = getPostingAccounts().length;
  const attention = getPostingAccounts().filter((a) => ['stalled', 'blocked', 'error', 'shadowban'].includes(a.status)).length;
  const live = getPostingAccounts().filter((a) => a.postingEnabled && a.status === 'smooth' && !a.paused).length;

  els.subtitle.textContent = `${total} accounts · ${automationEnabled ? 'automation on' : 'automation off'} · monitoring ${monitoredCount} sources`;
  els.monitorStatus.textContent = monitorStatus;
  els.monitorBadge.className = `monitor-badge ${monitorStatus}`;

  els.tabAll.textContent = total;
  els.tabAttention.textContent = attention;
  els.tabLive.textContent = live;

  renderKpis(summary);
  renderAccountsTable();
  renderSourceAccounts();
  renderLastRepost();
  renderActivity();
}

async function removeAccount(username) {
  if (!confirm(`Remove @${username} and delete its cookies/browser data?`)) return;
  await fetch(`/api/accounts/${username}`, { method: 'DELETE' });
}

async function setPostingEnabled(username, enabled) {
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postingEnabled: enabled }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update posting setting');

    const idx = accounts.findIndex((a) => a.username === username);
    if (idx !== -1) accounts[idx] = { ...accounts[idx], ...data };
  } catch (err) {
    alert(err.message || 'Failed to update posting setting');
    renderAccountsTable();
  }
}

els.accountsTable.addEventListener('change', (e) => {
  const input = e.target.closest('[data-action="posting"]');
  if (!input) return;
  setPostingEnabled(input.dataset.username, input.checked);
});

els.accountsTable.addEventListener('click', (e) => {
  const loginBtn = e.target.closest('[data-action="login"]');
  if (loginBtn) {
    openRemoteLogin(loginBtn.dataset.username, loginBtn.dataset.profileId);
    return;
  }

  const btn = e.target.closest('[data-action="remove"]');
  if (!btn) return;
  removeAccount(btn.dataset.username);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    filter = tab.dataset.filter;
    renderAccountsTable();
  });
});

els.searchInput.addEventListener('input', (e) => {
  search = e.target.value.trim();
  renderAccountsTable();
});

function openModal() {
  els.addAccountModal.showModal();
}

function closeModal() {
  els.addAccountModal.close();
  els.addAccountForm.reset();
}

function resetRemoteLoginUi() {
  remoteLogin.lastFrame = null;
  remoteLogin.loggedIn = false;
  remoteLogin.closing = false;
  els.remoteFrame.hidden = true;
  els.remoteFrame.removeAttribute('src');
  els.remoteLoading.hidden = false;
  els.remoteLoadingText.textContent = 'Starting remote session...';
  els.remoteStatus.textContent = '';
  els.remoteStatus.className = 'remote-status';
  els.saveSessionBtn.disabled = false;
}

function disconnectRemoteLogin() {
  if (remoteLogin.socket) {
    remoteLogin.socket.disconnect();
    remoteLogin.socket = null;
  }
}

function closeRemoteLogin() {
  if (remoteLogin.closing) return;

  const finishClose = () => {
    disconnectRemoteLogin();
    resetRemoteLoginUi();
    remoteLogin.username = null;
    remoteLogin.profileId = null;
    els.remoteLoginModal.close();
    refreshDashboard();
  };

  const socket = remoteLogin.socket;
  if (socket && socket.connected) {
    remoteLogin.closing = true;
    els.remoteStatus.textContent = 'Saving session...';
    socket.emit('closeSession');
    socket.once('sessionClosed', finishClose);
    setTimeout(finishClose, 3000);
    return;
  }

  finishClose();
}

function sendRemoteMouse(type, domEvent) {
  const socket = remoteLogin.socket;
  const img = els.remoteFrame;
  if (!socket || !img || img.hidden) return;

  const rect = img.getBoundingClientRect();
  const relX = domEvent.clientX - rect.left;
  const relY = domEvent.clientY - rect.top;
  const scaleX = VIEWPORT_WIDTH / rect.width;
  const scaleY = VIEWPORT_HEIGHT / rect.height;

  socket.emit('mouse', {
    type,
    x: Math.round(relX * scaleX),
    y: Math.round(relY * scaleY),
    button: domEvent.button === 2 ? 'right' : 'left',
  });
}

function startRemoteLoginSession() {
  disconnectRemoteLogin();
  resetRemoteLoginUi();

  if (!remoteLogin.username || !remoteLogin.profileId) {
    els.remoteStatus.textContent = 'Missing profile information';
    els.remoteStatus.className = 'remote-status error';
    return;
  }

  if (typeof io === 'undefined') {
    els.remoteStatus.textContent = 'Socket.IO failed to load';
    els.remoteStatus.className = 'remote-status error';
    return;
  }

  const socket = io('/threads-remote', {
    query: {
      username: remoteLogin.username,
      profileId: remoteLogin.profileId,
    },
  });

  remoteLogin.socket = socket;

  socket.on('connect', () => {
    socket.emit('startRemoteLogin');
  });

  socket.on('loading', (data) => {
    els.remoteLoading.hidden = false;
    els.remoteLoadingText.textContent = data?.message || 'Loading...';
  });

  socket.on('ready', () => {
    els.remoteLoadingText.textContent = 'Waiting for first frame...';
  });

  socket.on('screencast', ({ frame }) => {
    const src = `data:image/jpeg;base64,${frame}`;
    if (src === remoteLogin.lastFrame) return;
    remoteLogin.lastFrame = src;
    els.remoteFrame.src = src;
    els.remoteFrame.hidden = false;
    els.remoteLoading.hidden = true;
  });

  socket.on('loginSuccess', () => {
    remoteLogin.loggedIn = true;
    els.remoteStatus.textContent = 'Logged in — session saved. You can close this window.';
  });

  socket.on('sessionSaved', () => {
    remoteLogin.loggedIn = true;
    els.remoteStatus.textContent = 'Session saved.';
    els.saveSessionBtn.disabled = false;
  });

  socket.on('error', (payload) => {
    els.remoteStatus.textContent = payload?.message || 'Remote login error';
    els.remoteStatus.className = 'remote-status error';
    els.remoteLoading.hidden = false;
    els.saveSessionBtn.disabled = false;
  });

  socket.on('connect_error', () => {
    els.remoteStatus.textContent = 'Could not connect to remote login';
    els.remoteStatus.className = 'remote-status error';
  });
}

function openRemoteLogin(username, profileId) {
  if (!profileId) {
    const account = getPostingAccounts().find((a) => a.username === username);
    profileId = account?.kameleoProfileId;
  }
  if (!profileId) {
    alert('No Kameleo profile found for this account.');
    return;
  }

  remoteLogin.username = username;
  remoteLogin.profileId = profileId;
  els.remoteLoginTitle.textContent = `Remote login for @${username}`;
  els.remoteLoginModal.showModal();
  startRemoteLoginSession();
}

els.addAccountBtn.addEventListener('click', openModal);
els.closeModalBtn.addEventListener('click', closeModal);
els.cancelModalBtn.addEventListener('click', closeModal);
els.closeRemoteLoginBtn.addEventListener('click', closeRemoteLogin);

els.remoteLoginModal.addEventListener('close', () => {
  if (!remoteLogin.closing) disconnectRemoteLogin();
});

els.remoteFrame.addEventListener('click', (e) => sendRemoteMouse('click', e));
els.remoteFrame.addEventListener('mousemove', (e) => sendRemoteMouse('move', e));

els.remoteViewport.addEventListener('keydown', (e) => {
  const socket = remoteLogin.socket;
  if (!socket) return;
  e.preventDefault();
  if (e.key.length === 1) socket.emit('keyboard', { text: e.key });
  else socket.emit('keyboard', { key: e.key });
});

els.saveSessionBtn.addEventListener('click', () => {
  const socket = remoteLogin.socket;
  if (!socket) return;
  els.saveSessionBtn.disabled = true;
  socket.emit('saveSession');
});

els.addAccountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('accountUsername').value.trim();
  const submitBtn = els.addAccountForm.querySelector('[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add account');

    closeModal();
    openRemoteLogin(data.username, data.kameleoProfileId);
  } catch (err) {
    alert(err.message || 'Failed to add account');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

function connect() {
  refreshDashboard();

  const source = new EventSource('/api/events');
  source.onmessage = async (event) => {
    try {
      state = JSON.parse(event.data);
      await loadAccounts();
      render();
    } catch (err) {
      console.error(err);
    }
  };
  source.onerror = () => {
    source.close();
    refreshDashboard();
    setTimeout(connect, 3000);
  };
}

connect();
