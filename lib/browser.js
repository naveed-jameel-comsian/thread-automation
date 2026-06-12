const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const {
  getCookiesPath,
  getBrowserDataDir,
  getScannerBrowserDataDir,
  getPostingAccount,
  updatePostingAccountMeta,
} = require('./accounts');
const kameleo = require('./kameleo');

chromium.use(stealth());

/** username -> Promise<{ context, browser?, profileId?, mode }> */
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

async function connectKameleoSession(username) {
  const account = getPostingAccount(username);
  if (!account) throw new Error(`Posting account @${username} not found`);

  const profileId = await kameleo.ensureProfileForAccount(username, account.kameleoProfileId);
  if (profileId !== account.kameleoProfileId) {
    updatePostingAccountMeta(username, { kameleoProfileId: profileId });
  }

  const session = await kameleo.connectPlaywright(profileId, (ctx) =>
    loadCookiesIntoContext(ctx, getCookiesPath(username)),
  );

  return {
    context: session.context,
    browser: session.browser,
    profileId: session.profileId,
    mode: 'kameleo',
  };
}

async function openAccountSession(username) {
  if (kameleo.isKameleoEnabled()) {
    return connectKameleoSession(username);
  }

  return launchPlaywrightPersistent(
    getBrowserDataDir(username),
    getCookiesPath(username),
  );
}

async function getScannerContext() {
  const key = '__scanner__';
  if (!sessionCache.has(key)) {
    const promise = launchPlaywrightPersistent(getScannerBrowserDataDir(), null);
    sessionCache.set(key, promise);
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

async function closeSession(username) {
  const cached = sessionCache.get(username);
  if (!cached) return;

  sessionCache.delete(username);
  const session = await cached;

  if (session.browser) {
    await session.browser.close().catch(() => {});
  } else if (session.context) {
    await session.context.close().catch(() => {});
  }

  if (session.profileId) {
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

async function ensureKameleoProfilesForAllAccounts(listAccountsFn) {
  if (!kameleo.isKameleoEnabled()) return;

  await kameleo.checkHealth();

  for (const account of listAccountsFn()) {
    const profileId = await kameleo.ensureProfileForAccount(
      account.username,
      account.kameleoProfileId,
    );
    if (profileId !== account.kameleoProfileId) {
      updatePostingAccountMeta(account.username, { kameleoProfileId: profileId });
    }
  }
}

module.exports = {
  getScannerContext,
  getAccountContext,
  invalidateAccountContext,
  closeAllContexts,
  ensureKameleoProfilesForAllAccounts,
  isKameleoEnabled: kameleo.isKameleoEnabled,
  checkKameleoHealth: kameleo.checkHealth,
  createKameleoProfileForAccount: kameleo.createProfileForAccount,
  deleteKameleoProfile: kameleo.deleteProfile,
};
