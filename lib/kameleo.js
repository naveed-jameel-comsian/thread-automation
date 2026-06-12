const { KameleoLocalApiClient } = require('@kameleo/local-api-client');
const { chromium } = require('playwright');

const KAMELEO_BASE = process.env.KAMELEO_API_URL || 'http://localhost:5050';
const KAMELEO_WS_HOST = process.env.KAMELEO_WS_HOST || `localhost:${new URL(KAMELEO_BASE).port || 5050}`;
const USE_KAMELEO = process.env.USE_KAMELEO !== 'false';

let client = null;

function isKameleoEnabled() {
  return USE_KAMELEO;
}

function getClient() {
  if (!client) {
    client = new KameleoLocalApiClient({ basePath: KAMELEO_BASE });
  }
  return client;
}

function getOsFamily() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function profileName(username) {
  return `threads-${username}`;
}

async function checkHealth() {
  await getClient().general.healthcheck();
  return true;
}

async function findProfileByName(name) {
  const profiles = await getClient().profile.listProfiles();
  return profiles.find((p) => p.name === name) || null;
}

async function createProfileForAccount(username) {
  const api = getClient();
  const fingerprints = await api.fingerprint.searchFingerprints('desktop', getOsFamily(), 'chrome');
  if (!fingerprints?.length) {
    throw new Error('Kameleo: no Chrome fingerprints found for this OS');
  }

  const profile = await api.profile.createProfile({
    fingerprintId: fingerprints[0].id,
    name: profileName(username),
    tags: ['threads-monitor', username],
    storage: 'local',
    startPage: 'https://www.threads.com',
  });

  return profile.id;
}

async function ensureProfileForAccount(username, existingProfileId) {
  if (existingProfileId) {
    try {
      await getClient().profile.readProfile(existingProfileId);
      return existingProfileId;
    } catch {
      // Profile was deleted in Kameleo — recreate below.
    }
  }

  const existing = await findProfileByName(profileName(username));
  if (existing?.id) return existing.id;

  return createProfileForAccount(username);
}

async function stopProfile(profileId) {
  if (!profileId) return;
  try {
    await getClient().profile.stopProfile(profileId);
  } catch {
    // Already stopped or missing.
  }
}

async function deleteProfile(profileId) {
  if (!profileId) return;
  await stopProfile(profileId);
  try {
    await getClient().profile.deleteProfile(profileId);
  } catch {
    // Already deleted.
  }
}

async function connectPlaywright(profileId, loadCookies) {
  const wsEndpoint = `ws://${KAMELEO_WS_HOST}/playwright/${profileId}`;
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 90000 });
  const context = browser.contexts()[0];
  if (loadCookies) await loadCookies(context);
  return { browser, context, profileId };
}

module.exports = {
  isKameleoEnabled,
  checkHealth,
  createProfileForAccount,
  ensureProfileForAccount,
  stopProfile,
  deleteProfile,
  connectPlaywright,
  profileName,
};
