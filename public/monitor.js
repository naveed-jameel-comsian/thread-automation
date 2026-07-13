let state = null;

const els = {
  subtitle: document.getElementById('subtitle'),
  postingModePill: document.getElementById('postingModePill'),
  monitorBadge: document.getElementById('monitorBadge'),
  monitorStatus: document.getElementById('monitorStatus'),
  kpiRow: document.getElementById('kpiRow'),
  sourceAccounts: document.getElementById('sourceAccounts'),
  lastAlert: document.getElementById('lastAlert'),
  alertHistory: document.getElementById('alertHistory'),
  alertCount: document.getElementById('alertCount'),
  scannerLog: document.getElementById('scannerLog'),
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
  if (mins < 60) return diffMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderKpis() {
  const summary = state.summary || {};
  const channels = (state.alertChannels || []).join(', ') || 'dashboard only';

  els.kpiRow.innerHTML = [
    { label: 'Sources', value: summary.sourceCount || 0, tone: 'cyan' },
    { label: 'Sources OK', value: summary.sourcesOk ?? '—', tone: 'green' },
    { label: 'Alerts sent', value: summary.totalAlerts || 0, tone: 'blue' },
    { label: 'Last check', value: formatRelative(state.lastCheckAt), tone: 'muted' },
    { label: 'Next check', value: formatRelative(state.nextCheckAt), tone: 'muted' },
  ].map((kpi) => `
    <div class="kpi">
      <div class="kpi-label">${kpi.label}</div>
      <div class="kpi-value kpi-${kpi.tone}">${escapeHtml(kpi.value)}</div>
    </div>
  `).join('');

  els.subtitle.textContent = `${summary.sourceCount || 0} source accounts · alerts via ${channels}`;
}

function renderMode() {
  const postingOn = state.postingEnabled === true;
  els.postingModePill.textContent = postingOn ? 'Posting enabled' : 'Posting paused';
  els.postingModePill.className = `mode-pill ${postingOn ? 'posting-on' : 'posting-off'}`;

  const status = state.monitorStatus || 'idle';
  els.monitorStatus.textContent = status;
  els.monitorBadge.className = `monitor-badge ${status}`;
}

function renderSources() {
  const sources = Object.values(state.sourceAccounts || {});
  if (!sources.length) {
    els.sourceAccounts.innerHTML = '<div class="empty">No source accounts configured</div>';
    return;
  }

  els.sourceAccounts.innerHTML = sources.map((source) => `
    <div class="source-item">
      <div class="source-top">
        <strong>@${escapeHtml(source.username)}</strong>
        <span class="status-pill ${source.status === 'ok' ? 'ok' : source.status === 'error' ? 'error' : ''}">
          ${escapeHtml(source.status || 'pending')}
        </span>
      </div>
      <div class="source-meta">Checked ${formatRelative(source.lastCheckedAt)}</div>
      <div class="source-post">${escapeHtml((source.lastPostText || 'No recent post captured').slice(0, 180))}</div>
      ${source.lastPostUrl ? `<a class="source-link" href="${escapeHtml(source.lastPostUrl)}" target="_blank" rel="noopener">Open latest post</a>` : ''}
      ${source.lastError ? `<div class="source-error">${escapeHtml(source.lastError)}</div>` : ''}
    </div>
  `).join('');
}

function renderAlertCard(alert, compact = false) {
  const failed = alert.success === false;
  const channels = (alert.channels || []).map((ch) => `<span class="channel-tag">${escapeHtml(ch)}</span>`).join('');

  return `
    <div class="alert-card ${failed ? 'failed' : ''}">
      <div class="alert-card-header">
        <div class="alert-card-title">@${escapeHtml(alert.sourceUsername)}</div>
        <div class="alert-card-meta">${formatTime(alert.at)}</div>
      </div>
      ${alert.topic ? `<div class="alert-card-meta">Topic: ${escapeHtml(alert.topic)}</div>` : ''}
      ${alert.textPreview ? `<p class="alert-card-text">${escapeHtml(alert.textPreview)}</p>` : ''}
      ${alert.sourcePostUrl ? `<div class="alert-card-link"><a href="${escapeHtml(alert.sourcePostUrl)}" target="_blank" rel="noopener">Open thread</a></div>` : ''}
      ${channels ? `<div class="alert-channels">${channels}</div>` : ''}
      ${failed && alert.error ? `<div class="source-error">${escapeHtml(alert.error)}</div>` : ''}
    </div>
  `;
}

function renderAlerts() {
  const history = state.alertHistory || [];
  els.alertCount.textContent = `${history.length} alert${history.length === 1 ? '' : 's'}`;

  if (state.lastAlert) {
    els.lastAlert.innerHTML = renderAlertCard(state.lastAlert, true);
  } else {
    els.lastAlert.innerHTML = '<div class="empty">No alerts yet</div>';
  }

  if (!history.length) {
    els.alertHistory.innerHTML = '<div class="empty">Alerts will appear here when new threads are detected</div>';
    return;
  }

  els.alertHistory.innerHTML = history.map((alert) => renderAlertCard(alert)).join('');
}

function renderScannerLog() {
  const logs = (state.activityLog || []).filter((entry) => {
    const category = entry.category;
    if (category === 'scanner' || category === 'alert') return true;
    const message = entry.message || '';
    return /alert|scan|monitor|seeded|checking|posting disabled|scanner/i.test(message);
  });

  if (!logs.length) {
    els.scannerLog.innerHTML = '<div class="empty">Scanner activity will appear here</div>';
    return;
  }

  els.scannerLog.innerHTML = logs.map((entry) => `
    <div class="log-item ${entry.category || ''} ${entry.level || 'info'}">
      <div class="log-time">${formatTime(entry.at)}</div>
      <div class="log-message">${escapeHtml(entry.message)}</div>
      ${entry.sourcePostUrl ? `<a class="log-link" href="${escapeHtml(entry.sourcePostUrl)}" target="_blank" rel="noopener">Open thread</a>` : ''}
    </div>
  `).join('');
}

function render() {
  if (!state) return;
  renderMode();
  renderKpis();
  renderSources();
  renderAlerts();
  renderScannerLog();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 3000);
  };
}

async function init() {
  const res = await fetch('/api/status');
  state = await res.json();
  render();
  connectEvents();
}

init().catch((err) => {
  console.error(err);
  els.scannerLog.innerHTML = `<div class="empty">Failed to load dashboard: ${escapeHtml(err.message)}</div>`;
});
