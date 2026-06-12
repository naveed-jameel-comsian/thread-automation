const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  getPublicState,
  onStateChange,
  syncPostingAccounts,
  removePostingAccountState,
  setPostingAccountPaused,
  addLog,
} = require('../lib/store');
const {
  listPostingAccounts,
  addPostingAccount,
  removePostingAccount,
  updatePostingAccountMeta,
  getPostingAccount,
  sanitizeUsername,
} = require('../lib/accounts');
const {
  invalidateAccountContext,
  createKameleoProfileForAccount,
  deleteKameleoProfile,
  isKameleoEnabled,
} = require('../lib/browser');

function createDashboardServer(port = 3000) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', (_req, res) => {
    res.json(getPublicState());
  });

  app.get('/api/accounts', (_req, res) => {
    const registry = listPostingAccounts();
    const state = getPublicState();
    const merged = registry.map((entry) => ({
      ...entry,
      ...(state.postingAccounts[entry.username] || {}),
    }));
    res.json(merged);
  });

  app.post('/api/accounts', async (req, res) => {
    let kameleoProfileId = null;
    try {
      const { username, cookies } = req.body || {};
      const clean = sanitizeUsername(username);
      if (!clean) throw new Error('Username is required');

      if (isKameleoEnabled()) {
        kameleoProfileId = await createKameleoProfileForAccount(clean);
      }

      const account = addPostingAccount(clean, cookies, { kameleoProfileId });
      syncPostingAccounts([account.username]);
      addLog(
        'success',
        `Added posting account @${account.username}${kameleoProfileId ? ` (Kameleo ${kameleoProfileId.slice(0, 8)}…)` : ''}`,
      );
      res.status(201).json(account);
    } catch (err) {
      if (kameleoProfileId) await deleteKameleoProfile(kameleoProfileId).catch(() => {});
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/accounts/:username', async (req, res) => {
    try {
      const { paused } = req.body || {};
      const entry = updatePostingAccountMeta(req.params.username, { paused: Boolean(paused) });
      setPostingAccountPaused(entry.username, Boolean(paused));
      addLog('info', `@${entry.username} ${paused ? 'paused' : 'resumed'}`);
      res.json(entry);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:username', async (req, res) => {
    try {
      const username = req.params.username;
      const account = getPostingAccount(username);
      await invalidateAccountContext(username);
      if (account?.kameleoProfileId) {
        await deleteKameleoProfile(account.kameleoProfileId);
      }
      removePostingAccount(username);
      removePostingAccountState(username);
      addLog('warn', `Removed posting account @${username}`);
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
