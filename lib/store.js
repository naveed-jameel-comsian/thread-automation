const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'dashboard-state.json');
const MAX_HISTORY = 30;
const MAX_LOG = 100;

const defaultState = () => ({
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  nextCheckAt: null,
  pollIntervalMs: 10 * 60 * 1000,
  monitorStatus: 'starting',
  monitoredAccounts: [],
  ourAccount: {
    username: null,
    lastPostAt: null,
    lastPostText: null,
    lastPostUrl: null,
    lastCheckedAt: null,
  },
  accounts: {},
  lastRepost: null,
  repostHistory: [],
  activityLog: [],
  stats: {
    totalReposts: 0,
    totalChecks: 0,
    errors: 0,
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
  for (const listener of listeners) listener(state);
}

function getState() {
  return state;
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

function initAccounts(usernames) {
  state.monitoredAccounts = usernames;
  for (const username of usernames) {
    if (!state.accounts[username]) {
      state.accounts[username] = {
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

function updateAccountCheck(username, data) {
  state.accounts[username] = {
    ...state.accounts[username],
    ...data,
    lastCheckedAt: new Date().toISOString(),
    status: 'ok',
    lastError: null,
  };
  saveState();
}

function updateAccountError(username, error) {
  state.accounts[username] = {
    ...state.accounts[username],
    lastCheckedAt: new Date().toISOString(),
    status: 'error',
    lastError: String(error),
  };
  state.stats.errors += 1;
  saveState();
}

function updateOurAccount(data) {
  state.ourAccount = {
    ...state.ourAccount,
    ...data,
    lastCheckedAt: new Date().toISOString(),
  };
  saveState();
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

  state.ourAccount = {
    ...state.ourAccount,
    lastPostAt: repost.at,
    lastPostText: repost.repostText,
    lastPostUrl: null,
    lastCheckedAt: new Date().toISOString(),
  };

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
  saveState();
}

module.exports = {
  getState,
  onStateChange,
  addLog,
  initAccounts,
  setMonitorStatus,
  setPollInterval,
  markCheckStart,
  markCheckEnd,
  updateAccountCheck,
  updateAccountError,
  updateOurAccount,
  recordRepost,
  recordRepostFailure,
};
