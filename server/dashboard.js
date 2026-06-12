const path = require('path');
const express = require('express');
const cors = require('cors');
const { getState, onStateChange } = require('../lib/store');

function createDashboardServer(port = 3000) {
  const app = express();
  app.use(cors());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', (_req, res) => {
    res.json(getState());
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(getState());
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
