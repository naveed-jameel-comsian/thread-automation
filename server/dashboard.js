const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const {
  getPublicState,
  onStateChange,
  removePostingAccountState,
  setPostingAccountPaused,
  setPostingAccountEnabled,
  patchPostingAccountSettings,
  addLog,
} = require('../lib/store');
const { sanitizeUsername } = require('../lib/accounts');
const {
  invalidateAccountContext,
  listRepostProfiles,
  ensureKameleoProfileForAccount,
  deleteKameleoProfileByUsername,
  isKameleoEnabled,
} = require('../lib/browser');
const { registerRemoteLogin } = require('./remote-login');

async function getDashboardAccounts() {
  const state = getPublicState();

  try {
    const profiles = isKameleoEnabled() ? await listRepostProfiles() : [];
    return profiles.map((profile) => ({
      ...profile,
      ...(state.postingAccounts[profile.username] || {}),
      username: profile.username,
      kameleoProfileId: profile.id,
      postingEnabled: state.postingAccounts[profile.username]?.postingEnabled === true,
    }));
  } catch {
    return Object.values(state.postingAccounts || {}).map((account) => ({
      ...account,
      postingEnabled: account.postingEnabled === true,
    }));
  }
}

function createDashboardServer(port = 3000) {
  const DASHBOARD_VERSION = String(process.env.DASHBOARD_VERSION || 'v1').toLowerCase() === 'v2' ? 'v2' : 'v1';
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (_req, res) => {
    const file = DASHBOARD_VERSION === 'v2' ? 'monitor.html' : 'index.html';
    res.sendFile(path.join(__dirname, '..', 'public', file));
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  app.get('/api/status', (_req, res) => {
    res.json(getPublicState());
  });

  app.get('/api/accounts', async (_req, res) => {
    try {
      res.json(await getDashboardAccounts());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/accounts', async (req, res) => {
    try {
      const { username } = req.body || {};
      const clean = sanitizeUsername(username);
      if (!clean) throw new Error('Username is required');

      if (!isKameleoEnabled()) {
        throw new Error('Kameleo is required — set USE_KAMELEO=true and start Kameleo CLI');
      }

      const profileId = await ensureKameleoProfileForAccount(clean);
      patchPostingAccountSettings(clean, {
        kameleoProfileId: profileId,
        displayName: clean,
        status: 'pending',
      });
      setPostingAccountEnabled(clean, false);
      addLog('success', `Created Kameleo profile @${clean} (${profileId.slice(0, 8)}…) — open remote login to sign in`);
      res.status(201).json({ username: clean, kameleoProfileId: profileId, postingEnabled: false });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/accounts/:username', async (req, res) => {
    try {
      const { paused, postingEnabled } = req.body || {};
      const username = sanitizeUsername(req.params.username);
      if (!username) throw new Error('Username is required');

      if (typeof paused === 'boolean') {
        setPostingAccountPaused(username, paused);
        addLog('info', `@${username} ${paused ? 'paused' : 'resumed'}`);
      }
      if (typeof postingEnabled === 'boolean') {
        setPostingAccountEnabled(username, postingEnabled);
        addLog('info', `@${username} posting ${postingEnabled ? 'enabled' : 'disabled'}`);
      }

      if (typeof paused !== 'boolean' && typeof postingEnabled !== 'boolean') {
        return res.status(400).json({ error: 'Provide paused or postingEnabled' });
      }

      const accounts = await getDashboardAccounts();
      const account = accounts.find((a) => a.username === username);
      res.json(account || { username, postingEnabled, paused });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:username', async (req, res) => {
    try {
      const username = sanitizeUsername(req.params.username);
      await invalidateAccountContext(username);
      if (isKameleoEnabled()) {
        await deleteKameleoProfileByUsername(username);
      }
      removePostingAccountState(username);
      addLog('warn', `Removed Kameleo profile @${username}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(getPublicState());
    const unsubscribe = onStateChange(send);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  const server = http.createServer(app);
  registerRemoteLogin(server);

  server.listen(port, () => {
    console.log(`Dashboard (${DASHBOARD_VERSION}): http://localhost:${port}`);
  });

  return { app, server };
}

module.exports = { createDashboardServer };
