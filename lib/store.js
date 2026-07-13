const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'dashboard-state.json');
const MAX_HISTORY = 50;
const MAX_LOG = 150;
const MAX_ALERT_HISTORY = 50;

const defaultState = () => ({
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  nextCheckAt: null,
  pollIntervalMs: 10 * 60 * 1000,
  monitorStatus: 'starting',
  automationEnabled: false,
  postingEnabled: false,
  dashboardVersion: 'v1',
  alertChannels: [],
  monitoredAccounts: [],
  sourceAccounts: {},
  postingAccounts: {},
  lastRepost: null,
  repostHistory: [],
  lastAlert: null,
  alertHistory: [],
  activityLog: [],
  stats: {
    totalReposts: 0,
    totalChecks: 0,
    totalAlerts: 0,
    errors: 0,
    failed24h: 0,
    alertsFailed24h: 0,
  },
});

function ensureDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return defaultState();
  }
}

let state = loadState();
const listeners = new Set();

function saveState() {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  for (const listener of listeners) listener(getPublicState());
}

function getState() {
  return state;
}

function getPublicState() {
  return {
    ...state,
    summary: computeSummary(),
  };
}

function onStateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function addLog(level, message, meta = {}) {
  state.activityLog.unshift({
    at: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
  state.activityLog = state.activityLog.slice(0, MAX_LOG);
  saveState();
}

function initSourceAccounts(usernames) {
  state.monitoredAccounts = usernames;
  for (const username of usernames) {
    if (!state.sourceAccounts[username]) {
      state.sourceAccounts[username] = {
        username,
        lastPostAt: null,
        lastPostId: null,
        lastPostText: null,
        lastPostUrl: null,
        lastCheckedAt: null,
        totalSeenPosts: 0,
        status: 'pending',
        lastError: null,
      };
    }
  }
  saveState();
}

function ensurePostingAccount(username) {
  if (!state.postingAccounts[username]) {
    state.postingAccounts[username] = {
      username,
      displayName: username,
      paused: false,
      postingEnabled: false,
      status: 'pending',
      lastPostAt: null,
      lastPostText: null,
      lastPostUrl: null,
      lastCheckedAt: null,
      lastError: null,
      postsToday: 0,
      postsTodayDate: null,
      reach: null,
      views24h: null,
      likes24h: null,
      followers: null,
      followerDelta: null,
      nextPostAt: null,
    };
  }
  return state.postingAccounts[username];
}

function syncPostingAccountsFromKameleo(profiles) {
  const seen = new Set();

  for (const profile of profiles) {
    const username = profile.username || profile.name;
    if (!username) continue;
    seen.add(username);

    const account = ensurePostingAccount(username);
    account.kameleoProfileId = profile.id || profile.kameleoProfileId;
    account.displayName = username;
  }

  for (const username of Object.keys(state.postingAccounts)) {
    if (!seen.has(username)) {
      delete state.postingAccounts[username];
    }
  }

  saveState();
}

function isPostingAllowed(username) {
  const account = state.postingAccounts[username];
  return Boolean(account?.postingEnabled && !account?.paused);
}

function patchPostingAccountSettings(username, patch) {
  const account = ensurePostingAccount(username);
  Object.assign(account, patch);
  saveState();
  return account;
}

function removePostingAccountState(username) {
  delete state.postingAccounts[username];
  saveState();
}

function setAutomationEnabled(enabled) {
  state.automationEnabled = Boolean(enabled);
  saveState();
}

function setPostingEnabled(enabled) {
  state.postingEnabled = Boolean(enabled);
  saveState();
}

function setDashboardVersion(version) {
  state.dashboardVersion = version === 'v2' ? 'v2' : 'v1';
  saveState();
}

function setAlertChannels(channels) {
  state.alertChannels = Array.isArray(channels) ? channels : [];
  saveState();
}

function setMonitorStatus(status) {
  state.monitorStatus = status;
  saveState();
}

function setPollInterval(ms) {
  state.pollIntervalMs = ms;
  saveState();
}

function markCheckStart() {
  state.stats.totalChecks += 1;
  state.monitorStatus = 'checking';
  saveState();
}

function markCheckEnd(nextCheckAt) {
  state.lastCheckAt = new Date().toISOString();
  state.nextCheckAt = nextCheckAt;
  state.monitorStatus = 'idle';
  saveState();
}

function updateSourceAccountCheck(username, data) {
  state.sourceAccounts[username] = {
    ...state.sourceAccounts[username],
    ...data,
    lastCheckedAt: new Date().toISOString(),
    status: 'ok',
    lastError: null,
  };
  saveState();
}

function updateSourceAccountError(username, error) {
  state.sourceAccounts[username] = {
    ...state.sourceAccounts[username],
    lastCheckedAt: new Date().toISOString(),
    status: 'error',
    lastError: String(error),
  };
  state.stats.errors += 1;
  saveState();
}

function bumpPostsToday(username) {
  const account = ensurePostingAccount(username);
  const today = new Date().toISOString().slice(0, 10);
  if (account.postsTodayDate !== today) {
    account.postsToday = 0;
    account.postsTodayDate = today;
  }
  account.postsToday += 1;
  account.lastPostAt = new Date().toISOString();
  saveState();
}

function updatePostingAccount(username, data) {
  const account = ensurePostingAccount(username);
  state.postingAccounts[username] = {
    ...account,
    ...data,
    lastCheckedAt: new Date().toISOString(),
  };
  saveState();
}

function setPostingAccountPaused(username, paused) {
  updatePostingAccount(username, {
    paused,
    status: paused ? 'paused' : 'smooth',
  });
}

function setPostingAccountEnabled(username, postingEnabled) {
  updatePostingAccount(username, {
    postingEnabled: Boolean(postingEnabled),
    status: postingEnabled ? 'smooth' : 'pending',
  });
}

function recordAlert(entry) {
  const alert = {
    at: new Date().toISOString(),
    success: true,
    ...entry,
  };

  state.lastAlert = alert;
  state.alertHistory.unshift(alert);
  state.alertHistory = state.alertHistory.slice(0, MAX_ALERT_HISTORY);
  state.stats.totalAlerts += 1;

  if (!entry.success) {
    state.stats.errors += 1;
    state.stats.alertsFailed24h += 1;
  }

  saveState();
  return alert;
}

function recordRepost(entry) {
  const repost = {
    at: new Date().toISOString(),
    success: true,
    ...entry,
  };

  state.lastRepost = repost;
  state.repostHistory.unshift(repost);
  state.repostHistory = state.repostHistory.slice(0, MAX_HISTORY);
  state.stats.totalReposts += 1;

  if (entry.targetUsername) {
    bumpPostsToday(entry.targetUsername);
    updatePostingAccount(entry.targetUsername, {
      lastPostText: entry.repostText,
      status: 'smooth',
      lastError: null,
    });
  }

  saveState();
}

function recordRepostFailure(entry) {
  const repost = {
    at: new Date().toISOString(),
    success: false,
    ...entry,
  };
  state.lastRepost = repost;
  state.repostHistory.unshift(repost);
  state.repostHistory = state.repostHistory.slice(0, MAX_HISTORY);
  state.stats.errors += 1;
  state.stats.failed24h += 1;

  if (entry.targetUsername) {
    updatePostingAccount(entry.targetUsername, {
      status: 'stalled',
      lastError: entry.error || 'Repost failed',
    });
  }

  saveState();
}

function computeSummary() {
  const accounts = Object.values(state.postingAccounts);
  const active = accounts.filter((a) => a.postingEnabled && !a.paused);
  const sources = Object.values(state.sourceAccounts);

  return {
    total: accounts.length,
    running: active.filter((a) => a.status === 'smooth').length,
    atRisk: active.filter((a) => a.status === 'shadowban').length,
    down: accounts.filter((a) => ['stalled', 'blocked', 'error'].includes(a.status)).length,
    paused: accounts.filter((a) => a.paused || a.status === 'paused').length,
    views24h: sumMetric(accounts, 'views24h'),
    netFollows24h: sumMetric(accounts, 'followerDelta'),
    failed24h: state.stats.failed24h || 0,
    sourceCount: state.monitoredAccounts.length,
    sourcesOk: sources.filter((s) => s.status === 'ok').length,
    totalAlerts: state.stats.totalAlerts || 0,
    alertsFailed24h: state.stats.alertsFailed24h || 0,
    postingEnabled: state.postingEnabled,
    dashboardVersion: state.dashboardVersion,
  };
}

function sumMetric(accounts, key) {
  const values = accounts.map((a) => a[key]).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

module.exports = {
  getState,
  getPublicState,
  onStateChange,
  addLog,
  initSourceAccounts,
  syncPostingAccountsFromKameleo,
  isPostingAllowed,
  patchPostingAccountSettings,
  removePostingAccountState,
  setAutomationEnabled,
  setPostingEnabled,
  setDashboardVersion,
  setAlertChannels,
  setMonitorStatus,
  setPollInterval,
  markCheckStart,
  markCheckEnd,
  updateSourceAccountCheck,
  updateSourceAccountError,
  updatePostingAccount,
  setPostingAccountPaused,
  setPostingAccountEnabled,
  recordRepost,
  recordRepostFailure,
  recordAlert,
};
