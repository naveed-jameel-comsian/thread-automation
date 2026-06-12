let state = null;
let filter = 'all';
let search = '';

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
  return Object.values(state?.postingAccounts || {});
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
    list = list.filter((a) => a.status === 'smooth' && !a.paused);
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
    els.accountsTable.innerHTML = `<tr><td colspan="10" class="empty">No posting accounts yet — click "+ Add account"</td></tr>`;
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
          <div class="row-actions">
            <button class="icon-btn" title="${a.paused ? 'Resume' : 'Pause'}" data-action="toggle" data-username="${a.username}">${a.paused ? '▶' : '⏸'}</button>
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
  if (!state) return;

  const summary = state.summary || {};
  const total = getPostingAccounts().length;
  const attention = getPostingAccounts().filter((a) => ['stalled', 'blocked', 'error', 'shadowban'].includes(a.status)).length;
  const live = getPostingAccounts().filter((a) => a.status === 'smooth' && !a.paused).length;

  els.subtitle.textContent = `${total} accounts · auto-reposting trading signals · monitoring ${state.monitoredAccounts?.length || 0} sources`;
  els.monitorStatus.textContent = state.monitorStatus || 'unknown';
  els.monitorBadge.className = `monitor-badge ${state.monitorStatus || 'starting'}`;

  els.tabAll.textContent = total;
  els.tabAttention.textContent = attention;
  els.tabLive.textContent = live;

  renderKpis(summary);
  renderAccountsTable();
  renderSourceAccounts();
  renderLastRepost();
  renderActivity();
}

async function togglePause(username) {
  const account = state.postingAccounts[username];
  await fetch(`/api/accounts/${username}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !account?.paused }),
  });
}

async function removeAccount(username) {
  if (!confirm(`Remove @${username} and delete its cookies/browser data?`)) return;
  await fetch(`/api/accounts/${username}`, { method: 'DELETE' });
}

els.accountsTable.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const username = btn.dataset.username;
  if (btn.dataset.action === 'toggle') togglePause(username);
  if (btn.dataset.action === 'remove') removeAccount(username);
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

els.addAccountBtn.addEventListener('click', openModal);
els.closeModalBtn.addEventListener('click', closeModal);
els.cancelModalBtn.addEventListener('click', closeModal);

els.addAccountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('accountUsername').value.trim();
  const cookiesRaw = document.getElementById('accountCookies').value.trim();

  let cookies;
  try {
    cookies = JSON.parse(cookiesRaw);
  } catch {
    alert('Cookies must be valid JSON array');
    return;
  }

  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, cookies }),
  });

  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to add account');
    return;
  }

  closeModal();
});

function connect() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    try {
      state = JSON.parse(event.data);
      render();
    } catch (err) {
      console.error(err);
    }
  };
  source.onerror = () => {
    source.close();
    setTimeout(connect, 3000);
  };
}

connect();
