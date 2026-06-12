function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatRelative(value) {
  if (!value) return '—';
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return diffMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  return formatTime(value);
}

function truncate(text, max = 120) {
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function renderLastRepost(lastRepost) {
  const el = document.getElementById('lastRepost');
  if (!lastRepost) {
    el.className = 'empty-state';
    el.textContent = 'No reposts yet';
    return;
  }

  el.className = 'detail-list';
  el.innerHTML = `
    <div class="detail-row">
      <span class="label">Time</span>
      <strong>${formatTime(lastRepost.at)} (${formatRelative(lastRepost.at)})</strong>
    </div>
    <div class="detail-row">
      <span class="label">Source</span>
      <strong>@${lastRepost.sourceUsername || 'unknown'}</strong>
      ${lastRepost.sourcePostUrl ? `<a href="${lastRepost.sourcePostUrl}" target="_blank" rel="noreferrer">View original</a>` : ''}
    </div>
    <div class="detail-row">
      <span class="label">Status</span>
      <strong class="${lastRepost.success ? 'status-ok' : 'status-error'}">${lastRepost.success ? 'Success' : 'Failed'}</strong>
    </div>
    <div class="detail-row">
      <span class="label">Media</span>
      <strong>${lastRepost.mediaCount || 0} file(s)</strong>
    </div>
    <div class="detail-row">
      <span class="label">Content</span>
      <div class="preview">${truncate(lastRepost.repostText, 400)}</div>
    </div>
  `;
}

function renderOurAccount(ourAccount) {
  document.getElementById('ourUsername').textContent = ourAccount.username ? `@${ourAccount.username}` : 'Detecting...';
  document.getElementById('ourAccount').innerHTML = `
    <div class="detail-row">
      <span class="label">Last post time</span>
      <strong>${formatTime(ourAccount.lastPostAt)}</strong>
      <span class="preview">${formatRelative(ourAccount.lastPostAt)}</span>
    </div>
    <div class="detail-row">
      <span class="label">Last checked</span>
      <strong>${formatTime(ourAccount.lastCheckedAt)}</strong>
    </div>
    <div class="detail-row">
      <span class="label">Last post preview</span>
      <div class="preview">${truncate(ourAccount.lastPostText, 300)}</div>
      ${ourAccount.lastPostUrl ? `<a href="${ourAccount.lastPostUrl}" target="_blank" rel="noreferrer">View post</a>` : ''}
    </div>
  `;
}

function renderAccounts(accounts) {
  const tbody = document.getElementById('accountsTable');
  const rows = Object.values(accounts || {});

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No monitored accounts</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((account) => `
    <tr>
      <td><a href="https://www.threads.com/@${account.username}" target="_blank" rel="noreferrer">@${account.username}</a></td>
      <td>
        <div>${formatTime(account.lastPostAt)}</div>
        <div class="preview">${formatRelative(account.lastPostAt)}</div>
      </td>
      <td>${formatTime(account.lastCheckedAt)}</td>
      <td>${account.totalSeenPosts ?? 0}</td>
      <td class="status-${account.status || 'pending'}">${account.status || 'pending'}${account.lastError ? `<div class="preview">${truncate(account.lastError, 80)}</div>` : ''}</td>
      <td class="preview-cell">
        ${truncate(account.lastPostText, 100)}
        ${account.lastPostUrl ? `<div><a href="${account.lastPostUrl}" target="_blank" rel="noreferrer">Open</a></div>` : ''}
      </td>
    </tr>
  `).join('');
}

function renderHistory(history) {
  const el = document.getElementById('repostHistory');
  if (!history?.length) {
    el.innerHTML = '<div class="empty-state">No repost history yet</div>';
    return;
  }

  el.innerHTML = history.map((item) => `
    <div class="history-item ${item.success ? '' : 'failed'}">
      <div class="history-meta">
        <span>@${item.sourceUsername || 'unknown'} · ${formatTime(item.at)}</span>
        <span class="${item.success ? 'status-ok' : 'status-error'}">${item.success ? 'ok' : 'failed'}</span>
      </div>
      <div class="preview">${truncate(item.repostText, 180)}</div>
    </div>
  `).join('');
}

function renderLog(log) {
  const el = document.getElementById('activityLog');
  if (!log?.length) {
    el.innerHTML = '<div class="empty-state">No activity yet</div>';
    return;
  }

  el.innerHTML = log.map((item) => `
    <div class="log-item ${item.level || 'info'}">
      <div class="log-meta">
        <span>${formatTime(item.at)}</span>
        <span>${item.level || 'info'}</span>
      </div>
      <div>${item.message}</div>
    </div>
  `).join('');
}

function render(state) {
  const statusEl = document.getElementById('monitorStatus');
  statusEl.textContent = state.monitorStatus || 'unknown';
  statusEl.className = `status-pill ${state.monitorStatus || 'starting'}`;

  document.getElementById('lastCheckAt').textContent = formatTime(state.lastCheckAt);
  document.getElementById('nextCheckAt').textContent = `${formatTime(state.nextCheckAt)} (${formatRelative(state.nextCheckAt)})`;
  document.getElementById('totalReposts').textContent = state.stats?.totalReposts ?? 0;
  document.getElementById('totalChecks').textContent = state.stats?.totalChecks ?? 0;

  renderLastRepost(state.lastRepost);
  renderOurAccount(state.ourAccount || {});
  renderAccounts(state.accounts);
  renderHistory(state.repostHistory);
  renderLog(state.activityLog);
}

function connect() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    try {
      render(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse dashboard state', err);
    }
  };
  source.onerror = () => {
    source.close();
    setTimeout(connect, 3000);
  };
}

connect();
