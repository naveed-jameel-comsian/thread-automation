const { KameleoLocalApiClient } = require('@kameleo/local-api-client');
const { chromium } = require('playwright');

const KAMELEO_BASE = process.env.KAMELEO_API_URL || 'http://localhost:5050';
const KAMELEO_WS_HOST = process.env.KAMELEO_WS_HOST || `localhost:${new URL(KAMELEO_BASE).port || 5050}`;
const USE_KAMELEO = process.env.USE_KAMELEO !== 'false';
const SCANNER_PROFILE_ID = process.env.KAMELEO_SCANNER_PROFILE_ID
  || '1556bbd8-7c8a-47a9-bfe7-4dba4cd348db';

const USERNAME_RE = /^[a-zA-Z0-9._]+$/;

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

function isUsernameProfileName(name) {
  return Boolean(name && USERNAME_RE.test(name));
}

async function checkHealth() {
  await getClient().general.healthcheck();
  return true;
}

async function listAllProfiles() {
  return getClient().profile.listProfiles();
}

function mapRepostProfile(profile) {
  return {
    id: profile.id,
    username: profile.name,
    kameleoProfileId: profile.id,
    displayName: profile.name,
    profileStatus: profile.status?.lifetimeState || null,
    createdAt: profile.createdAt || null,
  };
}

/** All Kameleo profiles except the scanner, where profile name = Threads username. */
async function listRepostProfiles() {
  const profiles = await listAllProfiles();
  return profiles
    .filter((p) => p.id !== SCANNER_PROFILE_ID)
    // .filter((p) => isUsernameProfileName(p.name))
    .map(mapRepostProfile);
}

async function getProfileByUsername(username) {
  const profiles = await listRepostProfiles();
  return profiles.find((p) => p.username === username) || null;
}

async function createProfileForAccount(username) {
  const api = getClient();
  const fingerprints = await api.fingerprint.searchFingerprints('desktop', getOsFamily(), 'chrome');
  if (!fingerprints?.length) {
    throw new Error('Kameleo: no Chrome fingerprints found for this OS');
  }

  const profile = await api.profile.createProfile({
    fingerprintId: fingerprints[0].id,
    name: username,
    tags: ['threads-monitor', username],
    storage: 'local',
    startPage: 'https://www.threads.com',
  });

  return profile.id;
}

async function ensureProfileForAccount(username) {
  const existing = await getProfileByUsername(username);
  if (existing) return existing.id;

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

async function deleteProfileByUsername(username) {
  const profile = await getProfileByUsername(username);
  if (profile) await deleteProfile(profile.id);
}

async function ensureProfileExists(profileId) {
  await getClient().profile.readProfile(profileId);
  return profileId;
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
  listAllProfiles,
  listRepostProfiles,
  getProfileByUsername,
  createProfileForAccount,
  ensureProfileForAccount,
  ensureProfileExists,
  stopProfile,
  deleteProfile,
  deleteProfileByUsername,
  connectPlaywright,
  isUsernameProfileName,
  SCANNER_PROFILE_ID,
};
