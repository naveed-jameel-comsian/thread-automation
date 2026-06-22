const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  getPublicState,
  onStateChange,
  removePostingAccountState,
  setPostingAccountPaused,
  setPostingAccountEnabled,
  addLog,
} = require('../lib/store');
const { sanitizeUsername } = require('../lib/accounts');
const {
  invalidateAccountContext,
  listRepostProfiles,
  createKameleoProfileForAccount,
  deleteKameleoProfileByUsername,
  isKameleoEnabled,
} = require('../lib/browser');

async function getDashboardAccounts() {
  const state = getPublicState();
  const profiles = isKameleoEnabled() ? await listRepostProfiles() : [];

  return profiles.map((profile) => ({
    ...profile,
    ...(state.postingAccounts[profile.username] || {}),
    username: profile.username,
    kameleoProfileId: profile.id,
    postingEnabled: state.postingAccounts[profile.username]?.postingEnabled === true,
  }));
}

function createDashboardServer(port = 3000) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

      const profileId = await createKameleoProfileForAccount(clean);
      setPostingAccountEnabled(clean, false);
      addLog('success', `Created Kameleo profile @${clean} (${profileId.slice(0, 8)}…)`);
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
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(getPublicState());
    const unsubscribe = onStateChange(send);

    req.on('close', () => {
      unsubscribe();
    });
  });

  app.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });

  return app;
}

module.exports = { createDashboardServer };
