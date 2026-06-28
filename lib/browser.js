const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const {
  getCookiesPath,
  getBrowserDataDir,
  getScannerBrowserDataDir,
} = require('./accounts');
const { getState } = require('./store');
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

async function connectScannerSession() {
  if (kameleo.isKameleoEnabled()) {
    await kameleo.ensureProfileExists(kameleo.SCANNER_PROFILE_ID);
    const session = await connectKameleoProfile(kameleo.SCANNER_PROFILE_ID);
    return { ...session, mode: 'kameleo-scanner' };
  }

  return launchPlaywrightPersistent(getScannerBrowserDataDir(), null);
}

async function stopKameleoProfile(profileId) {
  if (!profileId || !kameleo.isKameleoEnabled()) return;
  await kameleo.stopProfile(profileId);
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

  if (session.profileId) {
    await stopKameleoProfile(session.profileId);
  }
}

/** Stop scanner and release Kameleo before opening repost profiles. */
async function closeScannerSession() {
  await closeSession('__scanner__');
}

async function getScannerContext() {
  const key = '__scanner__';
  if (!sessionCache.has(key)) {
    sessionCache.set(key, connectScannerSession());
  }
  const session = await sessionCache.get(key);
  return session.context;
}

/** Fresh scanner connection after repost phase (Kameleo: only one profile at a time). */
async function reopenScannerSession() {
  await closeScannerSession();
  return getScannerContext();
}

async function resolveRepostProfileId(username, profileIdHint) {
  if (profileIdHint && profileIdHint !== kameleo.SCANNER_PROFILE_ID) {
    return profileIdHint;
  }

  const fromStore = getState().postingAccounts[username]?.kameleoProfileId;
  if (fromStore && fromStore !== kameleo.SCANNER_PROFILE_ID) {
    return fromStore;
  }

  const profile = await kameleo.getProfileByUsername(username);
  if (!profile) {
    throw new Error(`No Kameleo profile for @${username}`);
  }
  if (profile.id === kameleo.SCANNER_PROFILE_ID) {
    throw new Error(`Profile @${username} is the scanner profile — cannot repost from it`);
  }

  return profile.id;
}

/**
 * Open a repost account's own Kameleo profile (never the scanner).
 * Stops the scanner first — Kameleo runs one profile at a time.
 */
async function withRepostProfile(username, fn, profileIdHint) {
  if (!kameleo.isKameleoEnabled()) {
    const session = await launchPlaywrightPersistent(
      getBrowserDataDir(username),
      getCookiesPath(username),
    );
    try {
      return await fn(session.context);
    } finally {
      await session.context.close().catch(() => {});
    }
  }

  const profileId = await resolveRepostProfileId(username, profileIdHint);

  await closeScannerSession();
  await stopKameleoProfile(profileId);
  await kameleo.startProfile(profileId);
  const session = await connectKameleoProfile(profileId);

  try {
    return await fn(session.context);
  } finally {
    if (session.browser) await session.browser.close().catch(() => {});
    await stopKameleoProfile(profileId);
  }
}

async function getAccountContext(username) {
  return withRepostProfile(username, (context) => context);
}

async function invalidateAccountContext(username) {
  sessionCache.delete(username);
}

async function closeAllContexts() {
  for (const key of [...sessionCache.keys()]) {
    await closeSession(key);
  }
}

module.exports = {
  getScannerContext,
  closeScannerSession,
  reopenScannerSession,
  withRepostProfile,
  getAccountContext,
  invalidateAccountContext,
  closeAllContexts,
  listRepostProfiles: kameleo.listRepostProfiles,
  isKameleoEnabled: kameleo.isKameleoEnabled,
  checkKameleoHealth: kameleo.checkHealth,
  createKameleoProfileForAccount: kameleo.createProfileForAccount,
  ensureKameleoProfileForAccount: kameleo.ensureProfileForAccount,
  deleteKameleoProfile: kameleo.deleteProfile,
  deleteKameleoProfileByUsername: kameleo.deleteProfileByUsername,
  SCANNER_PROFILE_ID: kameleo.SCANNER_PROFILE_ID,
};
