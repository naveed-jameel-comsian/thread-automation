const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const {
  getCookiesPath,
  getBrowserDataDir,
  getScannerBrowserDataDir,
  getPostingAccount,
} = require('./accounts');
const kameleo = require('./kameleo');

chromium.use(stealth());

/** cache key -> Promise<{ context, browser?, profileId?, mode }> */
const sessionCache = new Map();

function normalizeSameSite(value) {
  if (value === undefined || value === null || value === '') return 'Lax';
  const s = String(value).trim();
  if (s === 'Strict' || s === 'Lax' || s === 'None') return s;
  const lower = s.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'lax') return 'Lax';
  if (lower === 'none' || lower === 'no_restriction') return 'None';
  if (lower === 'unspecified' || lower === 'extended' || lower === 'moderate') return 'Lax';
  return 'Lax';
}

function normalizeCookies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const sameSite = normalizeSameSite(c.sameSite);
    const secure = sameSite === 'None' ? true : c.secure !== false;
    return {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure,
      sameSite,
    };
  });
}

async function loadCookiesIntoContext(context, cookiesPath) {
  if (!cookiesPath || !fs.existsSync(cookiesPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  } catch {
    return;
  }
  const cookies = normalizeCookies(parsed);
  if (cookies.length) await context.addCookies(cookies);
}

async function launchPlaywrightPersistent(userDataDir, cookiesPath) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  await loadCookiesIntoContext(context, cookiesPath);
  return { context, browser: null, profileId: null, mode: 'playwright' };
}

async function connectKameleoProfile(profileId) {
  const session = await kameleo.connectPlaywright(profileId);
  return {
    context: session.context,
    browser: session.browser,
    profileId: session.profileId,
    mode: 'kameleo',
  };
}

async function connectKameleoAccount(username) {
  const profile = await kameleo.getProfileByUsername(username);
  if (!profile) {
    throw new Error(`No Kameleo profile named @${username} — profile name must match username`);
  }
  return connectKameleoProfile(profile.id);
}

async function openAccountSession(username) {
  if (kameleo.isKameleoEnabled()) {
    return connectKameleoAccount(username);
  }

  const account = getPostingAccount(username);
  if (!account) throw new Error(`Posting account @${username} not found`);

  return launchPlaywrightPersistent(
    getBrowserDataDir(username),
    getCookiesPath(username),
  );
}

async function connectScannerSession() {
  if (kameleo.isKameleoEnabled()) {
    await kameleo.ensureProfileExists(kameleo.SCANNER_PROFILE_ID);
    return connectKameleoProfile(kameleo.SCANNER_PROFILE_ID);
  }

  return launchPlaywrightPersistent(getScannerBrowserDataDir(), null);
}

async function getScannerContext() {
  const key = '__scanner__';
  if (!sessionCache.has(key)) {
    sessionCache.set(key, connectScannerSession());
  }
  const session = await sessionCache.get(key);
  return session.context;
}

async function getAccountContext(username) {
  if (!sessionCache.has(username)) {
    sessionCache.set(username, openAccountSession(username));
  }
  const session = await sessionCache.get(username);
  return session.context;
}

async function closeSession(key) {
  const cached = sessionCache.get(key);
  if (!cached) return;

  sessionCache.delete(key);
  const session = await cached;

  if (session.browser) {
    await session.browser.close().catch(() => {});
  } else if (session.context) {
    await session.context.close().catch(() => {});
  }

  if (session.profileId && session.mode !== 'kameleo-scanner' && key !== '__scanner__') {
    await kameleo.stopProfile(session.profileId);
  }
}

async function invalidateAccountContext(username) {
  await closeSession(username);
}

async function closeAllContexts() {
  for (const key of [...sessionCache.keys()]) {
    await closeSession(key);
  }
}

module.exports = {
  getScannerContext,
  getAccountContext,
  invalidateAccountContext,
  closeAllContexts,
  listRepostProfiles: kameleo.listRepostProfiles,
  isKameleoEnabled: kameleo.isKameleoEnabled,
  checkKameleoHealth: kameleo.checkHealth,
  createKameleoProfileForAccount: kameleo.createProfileForAccount,
  deleteKameleoProfile: kameleo.deleteProfile,
  deleteKameleoProfileByUsername: kameleo.deleteProfileByUsername,
  SCANNER_PROFILE_ID: kameleo.SCANNER_PROFILE_ID,
};
