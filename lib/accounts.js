const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ACCOUNTS_DIR = path.join(ROOT, 'data', 'accounts');
const REGISTRY_FILE = path.join(ACCOUNTS_DIR, 'registry.json');
const SCANNER_DIR = path.join(ROOT, 'data', 'scanner');

function ensureAccountsDir() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function sanitizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._]/g, '');
}

function loadRegistry() {
  ensureAccountsDir();
  if (!fs.existsSync(REGISTRY_FILE)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

function saveRegistry(registry) {
  ensureAccountsDir();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

function getAccountDir(username) {
  return path.join(ACCOUNTS_DIR, sanitizeUsername(username));
}

function getCookiesPath(username) {
  return path.join(getAccountDir(username), 'cookies.json');
}

function getBrowserDataDir(username) {
  return path.join(getAccountDir(username), 'browser-data');
}

function getScannerBrowserDataDir() {
  return path.join(SCANNER_DIR, 'browser-data');
}

function listPostingAccounts() {
  const registry = loadRegistry();
  return registry.accounts.map((entry) => ({
    ...entry,
    cookiesPath: getCookiesPath(entry.username),
    browserDataDir: getBrowserDataDir(entry.username),
  }));
}

function getPostingAccount(username) {
  const clean = sanitizeUsername(username);
  return listPostingAccounts().find((a) => a.username === clean) || null;
}

function parseCookiesInput(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  }
  throw new Error('Cookies must be a JSON array or string');
}

function addPostingAccount(username, cookiesInput, meta = {}) {
  const clean = sanitizeUsername(username);
  if (!clean) throw new Error('Username is required');

  const cookies = parseCookiesInput(cookiesInput);
  if (!cookies.length) throw new Error('Cookies array is empty');

  const registry = loadRegistry();
  if (registry.accounts.some((a) => a.username === clean)) {
    throw new Error(`Account @${clean} already exists`);
  }

  const accountDir = getAccountDir(clean);
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(getCookiesPath(clean), JSON.stringify(cookies, null, 2));

  const entry = {
    username: clean,
    addedAt: new Date().toISOString(),
    paused: false,
    kameleoProfileId: meta.kameleoProfileId || null,
  };

  registry.accounts.push(entry);
  saveRegistry(registry);

  return {
    ...entry,
    cookiesPath: getCookiesPath(clean),
    browserDataDir: getBrowserDataDir(clean),
  };
}

function updatePostingAccountMeta(username, patch) {
  const clean = sanitizeUsername(username);
  const registry = loadRegistry();
  const idx = registry.accounts.findIndex((a) => a.username === clean);
  if (idx === -1) throw new Error(`Account @${clean} not found`);

  registry.accounts[idx] = { ...registry.accounts[idx], ...patch };
  saveRegistry(registry);
  return registry.accounts[idx];
}

function removePostingAccount(username) {
  const clean = sanitizeUsername(username);
  const registry = loadRegistry();
  const before = registry.accounts.length;
  registry.accounts = registry.accounts.filter((a) => a.username !== clean);
  if (registry.accounts.length === before) {
    throw new Error(`Account @${clean} not found`);
  }
  saveRegistry(registry);

  const accountDir = getAccountDir(clean);
  if (fs.existsSync(accountDir)) {
    fs.rmSync(accountDir, { recursive: true, force: true });
  }
}

module.exports = {
  sanitizeUsername,
  listPostingAccounts,
  getPostingAccount,
  addPostingAccount,
  updatePostingAccountMeta,
  removePostingAccount,
  getCookiesPath,
  getBrowserDataDir,
  getScannerBrowserDataDir,
};
