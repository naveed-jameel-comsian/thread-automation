import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { ProfileManager } from "../../src/managers/profileManager.js";
import { config } from "../../src/config/config.js";
import fs from "fs";
import path from "path";

const VIEWPORT = { width: 1280, height: 900 };
chromium.use(stealth());

// Global tracking of active browsers per username to prevent duplicates
const activeBrowsers = new Map(); // username -> { browser, socketId, timestamp }

/**
 * Clean stale SingletonLock files that prevent browser from launching
 */
async function cleanStaleLocks(profilePath) {
  const lockFile = path.join(profilePath, "SingletonLock");
  try {
    if (fs.existsSync(lockFile)) {
      console.log(
        `🧹 [clean-locks] Removing stale SingletonLock from ${profilePath}`
      );
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch (error) {
    console.warn(`⚠️ [clean-locks] Could not remove lock file:`, error.message);
  }
  return false;
}

export function registerInstagramRemote(io, saveSessionForUsername) {
  const nsp = io.of("/ig-remote");

  nsp.on("connection", (socket) => {
    const { username } = socket.handshake.query || {};
    console.log("🔌 Remote IG connection", { socketId: socket.id, username });

    // Dedicated ephemeral browser per remote session, managed by Socket.IO.
    // This keeps the behaviour aligned with the original remote-desktop idea.
    let browser = null;
    let context = null;
    let page = null;
    let screenshotTimer = null;
    let checkInterval = null;
    let isLoggingIn = false;
    let hasSavedSession = false;
    let lastNonLoginUrl = null;
    let lastNonLoginSeenAt = 0;
    const navHistory = [];

    async function cleanup(reason = "unknown") {
      console.log("🧹 [remote-login] cleanup requested:", {
        socketId: socket.id,
        username,
        reason,
        lastUrl: page ? page.url() : null,
      });

      if (screenshotTimer) clearInterval(screenshotTimer);
      screenshotTimer = null;

      if (checkInterval) clearInterval(checkInterval);
      checkInterval = null;

      // Close browser and cleanup resources when socket disconnects
      // With persistent context, closing automatically saves browser profile to profiles folder
      try {
        if (browser) {
          await browser.close();
          console.log(
            "✅ [remote-login] browser closed and profile saved to profiles folder"
          );
        }
      } catch (error) {
        console.error(
          "❌ [remote-login] Error closing remote browser:",
          error.message
        );
      }

      // Remove from global tracking
      if (username && activeBrowsers.get(username)?.socketId === socket.id) {
        activeBrowsers.delete(username);
        console.log(
          `✅ [remote-login] Removed ${username} from active browsers`
        );
      }

      browser = null;
      context = null;
      page = null;
      isLoggingIn = false;
    }

    socket.on("disconnect", () => {
      console.log("🔌 Remote IG disconnected", socket.id);
      cleanup("socket disconnect");
    });

    socket.on("startRemoteLogin", async () => {
      if (!username) {
        socket.emit("error", { message: "Username is required" });
        return;
      }
      if (isLoggingIn) return;

      // Clear any existing intervals from previous sessions
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      if (screenshotTimer) {
        clearInterval(screenshotTimer);
        screenshotTimer = null;
      }

      isLoggingIn = true;

      // Emit loading state to frontend
      socket.emit("loading", { message: "Initializing browser..." });

      try {
        // Launch a persistent browser context for this remote session
        // This will automatically save the browser profile to the profiles folder
        const profileManager = new ProfileManager();
        const profilePath = profileManager.getProfilePath(username);
        console.log(`📁 [remote-login] using profile path: ${profilePath}`);

        // Check if there's already an active browser for this username
        if (activeBrowsers.has(username)) {
          console.log(
            `⚠️ [remote-login] Browser already active for ${username}, closing it first...`
          );
          const existing = activeBrowsers.get(username);
          try {
            await existing.browser.close();
            console.log(
              `✅ [remote-login] Closed existing browser for ${username}`
            );
          } catch (e) {
            console.warn(
              `⚠️ [remote-login] Error closing existing browser:`,
              e.message
            );
          }
          activeBrowsers.delete(username);
          // Wait a bit for cleanup
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Clean any stale lock files before launching
        await cleanStaleLocks(profilePath);

        // Use launchPersistentContext to save browser state to profiles folder
        const launchOptions = {
          headless: true,
          viewport: VIEWPORT,
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        };

        // Add proxy configuration if available
        if (config.proxy) {
          launchOptions.proxy = config.proxy;
          console.log(`🌐 [PROXY] Using proxy: ${config.proxy.server}`);
        }

        socket.emit("loading", { message: "Launching browser..." });

        // Try to launch browser with retry logic for lock file issues
        let launchAttempts = 0;
        const maxLaunchAttempts = 2;

        while (!browser && launchAttempts < maxLaunchAttempts) {
          try {
            browser = await chromium.launchPersistentContext(
              profilePath,
              launchOptions
            );

            // Register this browser in global tracking
            activeBrowsers.set(username, {
              browser,
              socketId: socket.id,
              timestamp: Date.now(),
            });
            console.log(`✅ [remote-login] Browser registered for ${username}`);
          } catch (launchError) {
            launchAttempts++;
            if (
              launchError.message.includes("ProcessSingleton") &&
              launchAttempts < maxLaunchAttempts
            ) {
              console.log(
                `🔄 [remote-login] ProcessSingleton error detected, cleaning locks and retrying (attempt ${launchAttempts}/${maxLaunchAttempts})...`
              );
              await cleanStaleLocks(profilePath);
              // Wait a bit before retry
              await new Promise((resolve) => setTimeout(resolve, 2000));
            } else {
              throw launchError;
            }
          }
        }

        if (!browser) {
          throw new Error("Failed to launch browser after multiple attempts");
        }

        // Get the first page (persistent context creates one automatically)
        const pages = browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();
        context = browser; // In persistent context, browser IS the context

        socket.emit("loading", { message: "Loading Instagram..." });

        // Grant permissions automatically to prevent permission popups
        // This prevents Instagram from showing notification/geolocation permission dialogs
        try {
          await context.grantPermissions(["notifications", "geolocation"], {
            origin: "https://www.instagram.com",
          });
          console.log(
            "✅ [remote-login] permissions granted (notifications, geolocation)"
          );
        } catch (error) {
          console.warn(
            "⚠️ [remote-login] could not grant permissions:",
            error.message
          );
        }

        // Navigate to Instagram login with better error handling and retries for slow internet
        let navigationSuccess = false;
        let retryCount = 0;
        const maxRetries = 3;

        while (!navigationSuccess && retryCount < maxRetries) {
          try {
            console.log(
              `🌐 [remote-login] navigating to IG homepage for ${username} (attempt ${
                retryCount + 1
              }/${maxRetries})`
            );

            // Navigate to Instagram homepage (not login page)
            // Instagram will automatically redirect to login if not logged in
            // OR show the feed if already logged in (saved cookies)
            await page.goto("https://www.instagram.com/", {
              waitUntil: "domcontentloaded",
              timeout: 60000, // 60 seconds for slow internet
            });

            // Wait a bit for page to render
            await page.waitForTimeout(2000);

            // Try to detect what page we're on
            try {
              // Wait for either:
              // 1. Login form (not logged in)
              // 2. Main feed/profile (already logged in)
              await Promise.race([
                // Login page indicators
                page
                  .waitForSelector(
                    'input[name="username"], article[role="presentation"], form#loginForm',
                    {
                      timeout: 10000,
                    }
                  )
                  .then(() => {
                    console.log(
                      "🔓 [remote-login] Login page detected (not logged in)"
                    );
                    return "login";
                  })
                  .catch(() => null),

                // Already logged in indicators
                page
                  .waitForSelector(
                    'a[href*="/direct/inbox/"], svg[aria-label="Home"], nav[role="navigation"]',
                    {
                      timeout: 10000,
                    }
                  )
                  .then(() => {
                    console.log(
                      "✅ [remote-login] Already logged in! (session exists)"
                    );
                    return "logged_in";
                  })
                  .catch(() => null),
              ]);
            } catch (selectorError) {
              console.warn(
                "⚠️ [remote-login] Could not detect page state, but page loaded:",
                page.url()
              );
            }

            navigationSuccess = true;
            console.log(
              "✅ [remote-login] initial navigation complete",
              page.url()
            );
            socket.emit("loading", { message: "Page loaded", complete: true });
          } catch (navError) {
            retryCount++;
            const errorMsg = navError.message || String(navError);
            console.warn(
              `⚠️ [remote-login] navigation attempt ${retryCount} failed:`,
              errorMsg
            );

            if (retryCount < maxRetries) {
              console.log(
                `🔄 [remote-login] Retrying navigation in 3 seconds...`
              );
              await page.waitForTimeout(3000);
            } else {
              console.error(
                "❌ [remote-login] All navigation attempts failed, but continuing..."
              );
              // Continue anyway - page might still be usable
              navigationSuccess = true;
            }
          }
        }

        // Wait for page to be ready before starting screenshots
        let pageReady = false;
        const checkPageReady = async () => {
          if (!page) return false;
          try {
            // Check if page has content loaded
            const readyState = await page.evaluate(() => {
              return document.readyState;
            });
            return readyState === "complete" || readyState === "interactive";
          } catch (e) {
            return false;
          }
        };

        // Wait for page to be ready (with timeout)
        const startTime = Date.now();
        const maxWaitTime = 10000; // 10 seconds max wait
        while (!pageReady && Date.now() - startTime < maxWaitTime) {
          pageReady = await checkPageReady();
          if (!pageReady) {
            await page.waitForTimeout(500);
          }
        }

        if (pageReady) {
          console.log("✅ [remote-login] Page is ready, starting screenshots");
          socket.emit("ready", { message: "Remote session ready" });
        } else {
          console.warn(
            "⚠️ [remote-login] Page not fully ready, but starting screenshots anyway"
          );
          socket.emit("ready", {
            message: "Remote session starting (page loading...)",
          });
        }

        // Send initial screenshot immediately (even if page not fully ready)
        const sendInitialScreenshot = async () => {
          if (!page) return;
          try {
            const buffer = await page
              .screenshot({
                type: "jpeg",
                quality: 70,
                timeout: 3000,
              })
              .catch(() => null);

            if (buffer) {
              const base64 = buffer.toString("base64");
              socket.emit("screencast", { frame: base64 });
            }
          } catch (e) {
            // Ignore initial screenshot errors
          }
        };

        // Send initial screenshot after a short delay
        setTimeout(sendInitialScreenshot, 1000);

        // Start screencast loop with better error handling
        screenshotTimer = setInterval(async () => {
          // Check if page/browser is still valid before proceeding
          if (!browser || !page || page.isClosed()) {
            if (screenshotTimer) {
              clearInterval(screenshotTimer);
              screenshotTimer = null;
            }
            return;
          }

          try {
            // Check if page is still valid before taking screenshot
            try {
              await page.evaluate(() => document.body);
            } catch (e) {
              // Page is not ready or crashed, skip this frame
              if (e.message && e.message.includes("Target crashed")) {
                if (screenshotTimer) {
                  clearInterval(screenshotTimer);
                  screenshotTimer = null;
                }
                socket.emit("sessionEnded");
              }
              return;
            }

            const buffer = await page.screenshot({
              type: "jpeg",
              quality: 75, // Balanced quality for slow internet
              timeout: 8000, // 8 second timeout for slow internet
            });
            const base64 = buffer.toString("base64");
            socket.emit("screencast", { frame: base64 });
          } catch (error) {
            const msg = error.message || "";

            // Check if page is closed or crashed
            const isPageClosed = !page || page.isClosed();
            const isTargetCrashed = msg.includes("Target crashed");
            const isTargetClosed = msg.includes("Target closed");
            const isSessionClosed = msg.includes("Session closed");
            const isProtocolError = msg.includes("Protocol error");
            const isBrowserClosed = msg.includes("Browser closed") || !browser;

            // If page crashed or closed, stop the timer
            if (
              isPageClosed ||
              isTargetCrashed ||
              isTargetClosed ||
              isSessionClosed ||
              isBrowserClosed
            ) {
              if (screenshotTimer) {
                clearInterval(screenshotTimer);
                screenshotTimer = null;
              }
              if (isTargetCrashed) {
                console.log(
                  "⚠️ [remote-login] Page crashed, stopping screenshots"
                );
              }
              socket.emit("sessionEnded");
              return;
            }

            // Only log other errors (not page closure/crash errors)
            if (!isProtocolError) {
              console.error("❌ [remote-login] screencast error:", {
                message: msg,
                url: page ? page.url() : null,
              });
            }
          }
        }, 2000); // 2 seconds for smoother streaming without UI flicker

        // Track all navigation events
        page.on("framenavigated", (frame) => {
          if (!page || frame !== page.mainFrame()) return;
          const currentUrl = frame.url();

          navHistory.push({ url: currentUrl, ts: Date.now() });
          console.log("➡️ [remote-login] navigation:", currentUrl);

          // NOTE: We are only logging for now; no automatic "bounce back" fix
          // to keep behaviour purely observational while debugging.
        });

        // Track page load events
        page.on("load", () => {
          if (page) {
            console.log("📄 [remote-login] page loaded:", page.url());
          }
        });

        // Track console messages from the page
        page.on("console", (msg) => {
          const text = msg.text();
          if (
            text.includes("error") ||
            text.includes("Error") ||
            text.includes("failed")
          ) {
            console.log("🌐 [remote-login] page console:", text);
          }
        });

        // Track network responses (especially redirects)
        page.on("response", (response) => {
          const status = response.status();
          const url = response.url();
          if (status >= 300 && status < 400) {
            console.log(`🔄 [remote-login] redirect: ${status} -> ${url}`);
          }
        });

        // Mouse events from client
        socket.on("mouse", async (event) => {
          if (!page) return;
          const { type, x, y, button = "left" } = event;
          try {
            if (type === "move") await page.mouse.move(x, y);
            if (type === "click") await page.mouse.click(x, y, { button });
          } catch (error) {
            console.error("mouse error:", error.message);
          }
        });

        // Keyboard events from client
        socket.on("keyboard", async ({ key, text }) => {
          if (!page) return;
          try {
            if (text) {
              // Type text (for username, password, etc.)
              await page.keyboard.type(text);
            } else if (key) {
              // Press special key (Enter, Tab, etc.)
              await page.keyboard.press(key);
            }
          } catch (error) {
            console.error("keyboard error:", error.message);
          }
        });

        // Manual save trigger from frontend (e.g. after 2FA / security checks)
        socket.on("saveSession", async () => {
          if (!context || !username) return;
          try {
            const cookies = await context.cookies();
            if (typeof saveSessionForUsername === "function") {
              await saveSessionForUsername(username, cookies);
              hasSavedSession = true;
            }
            socket.emit("sessionSaved");
          } catch (error) {
            console.error("Manual session save error:", error.message);
            socket.emit("error", { message: "Failed to save session" });
          }
        });

        // Handle modal close - save session before closing browser
        socket.on("closeSession", async () => {
          console.log(
            "🚪 [remote-login] User closing modal, saving session..."
          );
          if (!context || !username) {
            console.warn("⚠️ [remote-login] No context/username to save");
            socket.emit("sessionClosed");
            return;
          }

          try {
            const cookies = await context.cookies();
            console.log(
              `🍪 [remote-login] Saving ${cookies.length} cookies before close...`
            );

            if (typeof saveSessionForUsername === "function") {
              await saveSessionForUsername(username, cookies);
              hasSavedSession = true;
              console.log("✅ [remote-login] Session saved on modal close");
            }

            socket.emit("sessionClosed");
          } catch (error) {
            console.error(
              "❌ [remote-login] Error saving session on close:",
              error.message
            );
            socket.emit("sessionClosed"); // Close anyway
          }
        });

        // Poll for login success - wait until we reach the main Instagram page
        // (https://www.instagram.com/) which indicates successful login
        console.log("🔄 [remote-login] starting URL check interval");
        checkInterval = setInterval(async () => {
          // Stop immediately if socket disconnected
          if (!socket || !socket.connected) {
            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }
            console.log(
              "🛑 [remote-login] Socket disconnected, stopping URL checks"
            );
            return;
          }

          // Stop if browser, context, or page is closed
          if (!browser || !context || !page) {
            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }
            return;
          }
          try {
            // Double-check page is still valid before accessing
            if (!page || page.isClosed()) {
              if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
              }
              return;
            }

            // Wait a bit for page to stabilize (especially on slow internet)
            await page.waitForTimeout(500);

            const url = page.url();
            // Log current URL periodically to track changes even if navigation events don't fire
            // (but less frequently to reduce noise)
            if (Date.now() % 30000 < 1500) {
              // Only log every ~30 seconds
              console.log("🔍 [remote-login] current URL check:", url);
            }

            // Check if we've reached the main Instagram page (successful login)
            // Main page is: https://www.instagram.com/ (with or without trailing slash, with or without query params)
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const isMainPage =
              urlObj.hostname === "www.instagram.com" &&
              (pathname === "/" || pathname === "") &&
              !url.includes("/accounts/login") &&
              !url.includes("/auth_platform/") &&
              !url.includes("/challenge/");

            if (isMainPage) {
              // We've successfully reached the main Instagram page!
              if (!hasSavedSession) {
                console.log(
                  "🎉 [remote-login] SUCCESS! Reached main Instagram page:",
                  url
                );

                // IMPORTANT: Wait a bit for Instagram to fully establish the session
                // Instagram needs time to set all auth cookies after redirect
                console.log(
                  "⏳ [remote-login] Waiting 5 seconds for session to fully establish..."
                );
                await page.waitForTimeout(5000);

                const cookies = await context.cookies();
                console.log(
                  `🍪 [remote-login] retrieved ${cookies.length} cookies`
                );

                if (typeof saveSessionForUsername === "function") {
                  try {
                    await saveSessionForUsername(username, cookies);
                    hasSavedSession = true;
                    console.log(
                      "✅ [remote-login] cookies saved to cookies folder"
                    );
                  } catch (error) {
                    console.error(
                      "❌ [remote-login] Error saving cookies for username:",
                      username,
                      error.message
                    );
                  }
                }

                // Browser profile is automatically saved to profiles folder
                // when using persistent context (launchPersistentContext)
                const profileManager = new ProfileManager();
                const profilePath = profileManager.getProfilePath(username);
                console.log(
                  `✅ [remote-login] browser profile saved to: ${profilePath}`
                );

                socket.emit("loginSuccess");
                console.log("📤 [remote-login] loginSuccess event emitted");
              }
              // IMPORTANT: do NOT clear interval or cleanup here.
              // We keep monitoring and the browser open until the socket disconnects
              // so the user can keep using the remote session.
            } else if (url.includes("/accounts/login")) {
              // Only log every ~15 seconds to reduce console noise
              if (Date.now() % 15000 < 1500) {
                console.log(
                  "⏳ [remote-login] still on login page, waiting..."
                );
              }
            } else {
              // We're on an intermediate page (2FA, challenge, etc.)
              // Track it but don't save yet - wait for main page
              const previousUrl = lastNonLoginUrl;
              lastNonLoginUrl = url;
              lastNonLoginSeenAt = Date.now();

              if (url !== previousUrl) {
                console.log(
                  "🔄 [remote-login] on intermediate page (waiting for main page):",
                  url
                );
              }
            }
          } catch (error) {
            // If page/browser is closed, stop the interval
            if (
              error.message.includes("Target closed") ||
              error.message.includes("Session closed") ||
              error.message.includes("Browser closed") ||
              !browser ||
              !page
            ) {
              if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
              }
              return;
            }
            // Only log non-closure errors
            console.error(
              "❌ [remote-login] login check error:",
              error.message
            );
          }
        }, 1500);
      } catch (error) {
        console.error("❌ [remote-login] Fatal error:", error.message);
        socket.emit("error", {
          message: error.message || "Remote login failed",
        });
        await cleanup("launch error");
        isLoggingIn = false;
      }
    });
  });
}
