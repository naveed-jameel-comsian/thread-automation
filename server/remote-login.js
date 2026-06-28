const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const kameleo = require('../lib/kameleo');
const { getCookiesPath } = require('../lib/accounts');
const { closeScannerSession, reopenScannerSession } = require('../lib/browser');
const { addLog, patchPostingAccountSettings } = require('../lib/store');

const VIEWPORT = { width: 1280, height: 900 };
const THREADS_LOGIN = 'https://www.threads.com/login';

const activeSessions = new Map();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function isThreadsLoggedIn(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('threads.com')) return false;
    if (parsed.pathname.includes('/login')) return false;
    return parsed.pathname === '/' || parsed.pathname.startsWith('/@');
  } catch {
    return false;
  }
}

async function saveCookiesForUsername(username, cookies) {
  const cookiesPath = getCookiesPath(username);
  fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
}

function registerRemoteLogin(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  const nsp = io.of('/threads-remote');

  nsp.on('connection', (socket) => {
    const { username, profileId } = socket.handshake.query || {};
    let browser = null;
    let context = null;
    let page = null;
    let screenshotTimer = null;
    let checkInterval = null;
    let isStarting = false;
    let hasSavedSession = false;

    async function cleanup(reason = 'unknown') {
      if (screenshotTimer) clearInterval(screenshotTimer);
      screenshotTimer = null;

      if (checkInterval) clearInterval(checkInterval);
      checkInterval = null;

      try {
        if (browser) await browser.close().catch(() => {});
      } catch {
        // Ignore close errors.
      }

      if (profileId) {
        await kameleo.stopProfile(profileId).catch(() => {});
        const active = activeSessions.get(profileId);
        if (active?.socketId === socket.id) {
          activeSessions.delete(profileId);
        }
      }

      browser = null;
      context = null;
      page = null;
      isStarting = false;

      try {
        await reopenScannerSession();
      } catch {
        // Scanner may not be running.
      }
    }

    socket.on('disconnect', () => {
      cleanup('socket disconnect');
    });

    socket.on('mouse', async (event) => {
      if (!page) return;
      const { type, x, y, button = 'left' } = event || {};
      try {
        if (type === 'move') await page.mouse.move(x, y);
        if (type === 'click') await page.mouse.click(x, y, { button });
      } catch {
        // Ignore mouse errors during navigation.
      }
    });

    socket.on('keyboard', async ({ key, text }) => {
      if (!page) return;
      try {
        if (text) await page.keyboard.type(text);
        else if (key) await page.keyboard.press(key);
      } catch {
        // Ignore keyboard errors during navigation.
      }
    });

    socket.on('saveSession', async () => {
      if (!context || !username) return;
      try {
        if (!hasSavedSession) {
          const cookies = await context.cookies();
          await saveCookiesForUsername(username, cookies);
          patchPostingAccountSettings(username, {
            status: 'smooth',
            lastError: null,
          });
          hasSavedSession = true;
          addLog('success', `Session saved for @${username} via remote login`);
        }
        socket.emit('sessionSaved');
      } catch (err) {
        socket.emit('error', { message: err.message || 'Failed to save session' });
      }
    });

    socket.on('closeSession', async () => {
      try {
        if (context && username && !hasSavedSession) {
          const cookies = await context.cookies();
          await saveCookiesForUsername(username, cookies);
          patchPostingAccountSettings(username, {
            status: 'smooth',
            lastError: null,
          });
          hasSavedSession = true;
        }
      } catch {
        // Continue closing even if save fails.
      }
      socket.emit('sessionClosed');
      await cleanup('user close');
    });

    socket.on('startRemoteLogin', async () => {
      if (!username || !profileId) {
        socket.emit('error', { message: 'Username and profile ID are required' });
        return;
      }
      if (isStarting) return;

      if (profileId === kameleo.SCANNER_PROFILE_ID) {
        socket.emit('error', { message: 'Cannot use the scanner profile for remote login' });
        return;
      }

      isStarting = true;
      socket.emit('loading', { message: 'Initializing Kameleo profile...' });

      try {
        const existing = activeSessions.get(profileId);
        if (existing && existing.socketId !== socket.id) {
          try {
            await existing.browser?.close?.();
          } catch {
            // Ignore.
          }
          await kameleo.stopProfile(profileId).catch(() => {});
          activeSessions.delete(profileId);
          await delay(1000);
        }

        await closeScannerSession();
        await kameleo.stopProfile(profileId);
        await kameleo.startProfile(profileId);

        socket.emit('loading', { message: 'Connecting browser...' });
        const session = await kameleo.connectPlaywright(profileId);
        browser = session.browser;
        context = session.context;

        activeSessions.set(profileId, { browser, socketId: socket.id, username });

        const pages = context.pages();
        page = pages.length ? pages[0] : await context.newPage();
        await page.setViewportSize(VIEWPORT).catch(() => {});

        socket.emit('loading', { message: 'Loading Threads...' });
        await page.goto(THREADS_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(2000);

        socket.emit('loading', { message: 'Page loaded', complete: true });
        socket.emit('ready', { message: 'Remote session ready' });
        addLog('info', `Remote login started for @${username}`);

        const sendScreenshot = async () => {
          if (!page || page.isClosed()) return;
          try {
            const buffer = await page.screenshot({
              type: 'jpeg',
              quality: 75,
              timeout: 8000,
            });
            socket.emit('screencast', { frame: buffer.toString('base64') });
          } catch {
            // Skip failed frames.
          }
        };

        setTimeout(sendScreenshot, 1000);
        screenshotTimer = setInterval(sendScreenshot, 2000);

        const persistSession = async () => {
          if (!context || !username || hasSavedSession) return;
          const cookies = await context.cookies();
          await saveCookiesForUsername(username, cookies);
          patchPostingAccountSettings(username, {
            status: 'smooth',
            lastError: null,
          });
          hasSavedSession = true;
          addLog('success', `Session saved for @${username} via remote login`);
        };

        checkInterval = setInterval(async () => {
          if (!page || page.isClosed()) {
            if (checkInterval) clearInterval(checkInterval);
            return;
          }

          try {
            const url = page.url();
            if (isThreadsLoggedIn(url) && !hasSavedSession) {
              await delay(3000);
              await persistSession();
              socket.emit('loginSuccess');
            }
          } catch {
            // Ignore polling errors.
          }
        }, 2000);
      } catch (err) {
        socket.emit('error', { message: err.message || 'Remote login failed' });
        addLog('error', `Remote login failed for @${username}: ${err.message}`);
        await cleanup('launch error');
      } finally {
        isStarting = false;
      }
    });
  });

  return io;
}

module.exports = { registerRemoteLogin };
