const fs = require('fs');
const path = require('path');
const {
  addLog,
  initSourceAccounts,
  syncPostingAccountsFromKameleo,
  isPostingAllowed,
  setMonitorStatus,
  setPollInterval,
  markCheckStart,
  markCheckEnd,
  updateSourceAccountCheck,
  updateSourceAccountError,
  updatePostingAccount,
  recordRepost,
  recordRepostFailure,
} = require('./lib/store');
const {
  getScannerContext,
  getAccountContext,
  listRepostProfiles,
  isKameleoEnabled,
  checkKameleoHealth,
  SCANNER_PROFILE_ID,
} = require('./lib/browser');
const { createDashboardServer } = require('./server/dashboard');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '.');
const SEEN_POSTS_FILE = path.join(ROOT, 'seen-posts.json');
const MEDIA_DIR = path.join(ROOT, 'data', 'media');

const MONITORED_ACCOUNTS = ['kraven.0309', 'jinnie.3007'];
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const DASHBOARD_PORT = Number(process.env.PORT) || 3000;

function loadSeenPosts() {
  if (!fs.existsSync(SEEN_POSTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_POSTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeenPosts(seenPosts) {
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(seenPosts, null, 2));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function toIsoTimestamp(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toISOString();
}

function getLatestPost(posts) {
  return posts.reduce((latest, post) => {
    if (!latest) return post;
    return (post.timestamp || 0) > (latest.timestamp || 0) ? post : latest;
  }, null);
}

function createGraphQLCollector(page) {
  const posts = [];
  const seenIds = new Set();

  const handler = async (response) => {
    const url = response.url();
    if (!url.includes('/api/graphql')) return;
    try {
      const json = await response.json();
      for (const post of extractPostsFromGraphQL(json)) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          posts.push(post);
        }
      }
    } catch {
      // Not every graphql response is JSON we care about.
    }
  };

  page.on('response', handler);

  return {
    getPosts: () => posts,
    reset: () => {
      posts.length = 0;
      seenIds.clear();
    },
    detach: () => page.off('response', handler),
  };
}

function extractPostText(post) {
  if (post.caption?.text) return post.caption.text;
  if (typeof post.caption === 'string') return post.caption;

  const info = post.text_post_app_info;
  if (info?.post_preview) return info.post_preview;

  const fragments = info?.text_fragments?.fragments;
  if (Array.isArray(fragments)) {
    return fragments.map((f) => f.plaintext || f.text || '').join('');
  }

  return '';
}

function extractTopic(post) {
  const info = post.text_post_app_info;
  return info?.topic_cluster?.topic_name
    || info?.tag_header?.display_text
    || info?.topic_tag?.name
    || info?.custom_feed_preview_info?.name
    || null;
}

function extractMediaUrls(post) {
  const urls = [];

  const addFromVersions = (versions) => {
    const candidates = versions?.candidates;
    if (Array.isArray(candidates) && candidates[0]?.url) {
      urls.push(candidates[0].url);
    }
  };

  addFromVersions(post.image_versions2);

  if (Array.isArray(post.carousel_media)) {
    for (const item of post.carousel_media) {
      addFromVersions(item.image_versions2);
    }
  }

  return [...new Set(urls)];
}

function extractPostsFromGraphQL(data) {
  const posts = [];
  const seen = new Set();

  const addPost = (post, fallbackUsername) => {
    const id = String(post.code || post.pk || post.id || '');
    if (!id || seen.has(id)) return;

    const username = post.user?.username || fallbackUsername;
    const url = post.code && username
      ? `https://www.threads.com/@${username}/post/${post.code}`
      : null;

    seen.add(id);
    posts.push({
      id,
      text: extractPostText(post),
      url,
      username,
      topic: extractTopic(post),
      timestamp: post.taken_at || null,
      mediaUrls: extractMediaUrls(post),
    });
  };

  const walk = (node, fallbackUsername) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node.thread_items)) {
      for (const item of node.thread_items) {
        if (item?.post) addPost(item.post, fallbackUsername);
      }
    }

    if (Array.isArray(node.threads)) {
      for (const thread of node.threads) {
        walk(thread, fallbackUsername);
      }
    }

    if (node.code && (node.caption || node.text_post_app_info || node.taken_at)) {
      addPost(node, fallbackUsername);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, fallbackUsername);
      } else if (value && typeof value === 'object') {
        walk(value, fallbackUsername);
      }
    }
  };

  walk(data, null);
  return posts;
}

async function getProfilePostsFromDOM(page, username) {
  return page.evaluate((handle) => {
    function extractFromContainer(container) {
      if (!container) return { text: '', topic: null, mediaUrls: [] };

      const topicLink = container.querySelector('a[href*="serp_type=tags"]');
      const topic = topicLink?.textContent?.trim() || null;

      const body = container.querySelector('.x1xdureb.xkbb5z')
        || container.querySelector('.x1a6qonq')
        || container.querySelector('[data-lexical-editor="true"]');

      let text = '';
      if (body) {
        const clone = body.cloneNode(true);
        clone.querySelectorAll('a[href*="/media"], picture, img, video').forEach((el) => el.remove());
        text = clone.innerText?.trim() || '';
      }

      const images = [...container.querySelectorAll('picture img, a[href*="/media"] img')]
        .map((img) => img.src)
        .filter((src) => src && !src.includes('profile_pic') && !src.includes('s150x150'));

      return { text, topic, mediaUrls: [...new Set(images)] };
    }

    const posts = [];
    const seen = new Set();
    const containers = document.querySelectorAll('[data-pressable-container="true"]');

    for (const container of containers) {
      const postLink = container.querySelector(`a[href*="/@${handle}/post/"]`);
      if (!postLink) continue;

      const href = postLink.href.split('?')[0];
      const match = href.match(/\/post\/([^/?#]+)/);
      if (!match) continue;

      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const { text, topic, mediaUrls } = extractFromContainer(container);
      posts.push({
        id,
        text,
        url: href,
        username: handle,
        topic,
        timestamp: null,
        mediaUrls,
      });
    }

    return posts;
  }, username);
}

async function fetchProfilePosts(page, username, collector) {
  collector.reset();

  const profileUrl = `https://www.threads.com/@${username}`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(4000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await delay(1500);
  }

  let posts = collector.getPosts().filter((p) => p.id);
  if (!posts.length) {
    posts = await getProfilePostsFromDOM(page, username);
  }

  const byId = new Map();
  for (const post of posts) {
    if (!post.url && post.id) {
      post.url = `https://www.threads.com/@${username}/post/${post.id}`;
    }
    post.username = post.username || username;
    byId.set(post.id, post);
  }

  return [...byId.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

async function fetchPostDetail(page, post) {
  await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(3000);

  const detail = await page.evaluate(() => {
    const container = document.querySelector('[data-pressable-container="true"]')
      || document.querySelector('div[role="article"]');

    const topicLink = container?.querySelector('a[href*="serp_type=tags"]');
    const topic = topicLink?.textContent?.trim() || null;

    const body = container?.querySelector('.x1xdureb.xkbb5z')
      || container?.querySelector('.x1a6qonq')
      || container?.querySelector('[data-lexical-editor="true"]');

    let text = '';
    if (body) {
      const clone = body.cloneNode(true);
      clone.querySelectorAll('a[href*="/media"], picture, img, video').forEach((el) => el.remove());
      text = clone.innerText?.trim() || '';
    }

    const images = [...document.querySelectorAll('picture img, a[href*="/media"] img')]
      .map((img) => img.src)
      .filter((src) => src && !src.includes('profile_pic') && !src.includes('s150x150'));

    return { text, topic, mediaUrls: [...new Set(images)] };
  });

  return {
    ...post,
    text: detail.text || post.text,
    topic: detail.topic || post.topic || null,
    mediaUrls: [...new Set([...(post.mediaUrls || []), ...detail.mediaUrls])],
  };
}

async function downloadMedia(urls) {
  if (!urls.length) return [];

  ensureDir(MEDIA_DIR);
  const saved = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const filePath = path.join(MEDIA_DIR, `${Date.now()}-${i}${ext}`);

    const response = await fetch(url);
    if (!response.ok) continue;

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    saved.push(filePath);
  }

  return saved;
}

const NO_ATTRIBUTION_ACCOUNTS = ['jinnie.3007'];
const RELATIVE_TIME_RE = /^(?:\d+[smhdw]|\d+\s*(?:sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)(?:\s+ago)?)$/i;
const NOISE_LINE_RE = /^(?:\d+\/\d+|\d+|\/|like|reply|repost|share|follow|more)$/i;

function cleanRepostText(text, username, topic) {
  let lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';

  while (lines.length && RELATIVE_TIME_RE.test(lines[0])) {
    lines.shift();
  }

  if (username) {
    const userPattern = new RegExp(`^@?${username.replace(/\./g, '\\.')}$`, 'i');
    while (lines.length && userPattern.test(lines[0])) {
      lines.shift();
    }
  }

  if (topic) {
    while (lines.length && lines[0].toLowerCase() === topic.toLowerCase()) {
      lines.shift();
    }
  }

  if (username === 'jinnie.3007') {
    lines = lines
      .filter((line) => !/^\s*via\s*@?jinnie\.3007\s*$/i.test(line))
      .filter((line) => !/^\s*via\s*$/i.test(line))
      .map((line) => line.replace(/@jinnie\.3007/gi, '').replace(/jinnie\.3007/gi, '').trim())
      .filter(Boolean);
  }

  while (lines.length) {
    const last = lines[lines.length - 1];
    if (NOISE_LINE_RE.test(last)) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatRepostText(post) {
  const text = cleanRepostText(post.text?.trim() || '', post.username, post.topic);
  if (!text) return '';

  if (NO_ATTRIBUTION_ACCOUNTS.includes(post.username)) {
    return text;
  }

  const attribution = post.username ? `via @${post.username}` : '';
  return attribution ? `${text}\n\n${attribution}` : text;
}

async function openNewThreadComposer(page) {
  await page.goto('https://www.threads.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(3000);

  const newThreadBtn = page.getByRole('button', { name: 'New thread' });
  await newThreadBtn.waitFor({ state: 'visible', timeout: 20000 });
  await newThreadBtn.click();

  const composer = page.getByRole('textbox', { name: /Type to compose a new post/i });
  await composer.waitFor({ state: 'visible', timeout: 20000 });
  return composer;
}

async function setCommunityTopic(page, topic) {
  if (!topic) return;

  const topicInput = page.getByPlaceholder('Community or topic');
  await topicInput.waitFor({ state: 'visible', timeout: 10000 });
  await topicInput.click();
  await topicInput.fill(topic);
  await delay(1500);

  const matchingOption = page.locator('[role="option"]').filter({ hasText: topic }).first();
  if (await matchingOption.count()) {
    await matchingOption.click();
  } else {
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.isVisible().catch(() => false)) {
      await firstOption.click();
    } else {
      await page.keyboard.press('Enter');
    }
  }

  await delay(500);
}

async function createThread(page, text, mediaPaths = [], topic = null) {
  const composer = await openNewThreadComposer(page);
  await setCommunityTopic(page, topic);
  await composer.click();

  if (text) {
    await composer.pressSequentially(text, { delay: 30 });
  }

  if (mediaPaths.length) {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(mediaPaths);
    await delay(2000);
  }

  const postBtn = page.getByRole('button', { name: 'Post', exact: true });
  await postBtn.waitFor({ state: 'visible', timeout: 20000 });
  await postBtn.click();
  await delay(4000);

  log(`Posted thread: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
}

async function refreshPostingAccountProfile(page, username, collector) {
  const posts = await fetchProfilePosts(page, username, collector);
  const latest = getLatestPost(posts);

  const profileStats = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const followerMatch = bodyText.match(/([\d,.]+[kKmM]?)\s*followers?/i);
    return { followers: followerMatch ? followerMatch[1] : null };
  });

  updatePostingAccount(username, {
    displayName: username,
    lastPostAt: latest ? toIsoTimestamp(latest.timestamp) : null,
    lastPostText: latest?.text || null,
    lastPostUrl: latest?.url || null,
    followers: profileStats.followers,
    nextPostAt: stateNextCheck(),
    status: 'smooth',
    lastError: null,
  });
}

function stateNextCheck() {
  return new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
}

async function syncKameleoDashboardAccounts() {
  const profiles = await listRepostProfiles();
  syncPostingAccountsFromKameleo(profiles);
  return profiles;
}

async function repostToAllAccounts(text, mediaPaths, topic, sourceMeta) {
  const profiles = await listRepostProfiles();
  const targets = profiles.filter((p) => isPostingAllowed(p.username));

  if (!targets.length) {
    addLog('warn', 'No posting-enabled Kameleo profiles — enable posting from the dashboard');
    return false;
  }

  let anySuccess = false;

  for (const profile of targets) {
    try {
      const context = await getAccountContext(profile.username);
      const page = await context.newPage();
      try {
        await createThread(page, text, mediaPaths, topic);
        recordRepost({
          ...sourceMeta,
          targetUsername: profile.username,
          repostText: text,
          topic: topic || null,
          mediaCount: mediaPaths.length,
        });
        addLog('success', `Posted to @${profile.username} (from @${sourceMeta.sourceUsername})`);
        anySuccess = true;
      } finally {
        await page.close().catch(() => {});
      }
      await delay(4000);
    } catch (err) {
      recordRepostFailure({
        ...sourceMeta,
        targetUsername: profile.username,
        repostText: text,
        error: err.message,
      });
      addLog('error', `Failed posting to @${profile.username}: ${err.message}`);
    }
  }

  return anySuccess;
}

async function checkAccount(page, username, collector) {
  const seenPosts = loadSeenPosts();
  const accountSeen = new Set(seenPosts[username] || []);
  const isFirstRun = accountSeen.size === 0;

  log(`Checking @${username}...`);
  const posts = await fetchProfilePosts(page, username, collector);
  const latest = getLatestPost(posts);

  updateSourceAccountCheck(username, {
    lastPostAt: latest ? toIsoTimestamp(latest.timestamp) : null,
    lastPostId: latest?.id || null,
    lastPostText: latest?.text || null,
    lastPostUrl: latest?.url || null,
    totalSeenPosts: accountSeen.size,
  });

  log(`Found ${posts.length} posts on @${username}`);

  if (!posts.length) return;

  if (isFirstRun) {
    for (const post of posts) accountSeen.add(post.id);
    seenPosts[username] = [...accountSeen];
    saveSeenPosts(seenPosts);
    updateSourceAccountCheck(username, { totalSeenPosts: accountSeen.size });
    addLog('info', `Seeded ${posts.length} existing posts for @${username}`);
    return;
  }

  const newPosts = posts.filter((post) => !accountSeen.has(post.id));
  if (!newPosts.length) {
    addLog('info', `No new posts for @${username}`);
    return;
  }

  log(`Found ${newPosts.length} new post(s) for @${username}`);

  for (const post of newPosts) {
    try {
      const detail = await fetchPostDetail(page, post);
      const repostText = formatRepostText(detail);
      const mediaPaths = await downloadMedia(detail.mediaUrls || []);

      if (!repostText && !mediaPaths.length) {
        addLog('warn', `Skipping @${username}/${post.id}: no text or media found`);
        accountSeen.add(post.id);
        continue;
      }

      const posted = await repostToAllAccounts(repostText, mediaPaths, detail.topic, {
        sourceUsername: username,
        sourcePostId: post.id,
        sourcePostUrl: detail.url,
        sourcePostAt: toIsoTimestamp(detail.timestamp),
      });

      if (posted) {
        accountSeen.add(post.id);
        seenPosts[username] = [...accountSeen];
        saveSeenPosts(seenPosts);
        updateSourceAccountCheck(username, { totalSeenPosts: accountSeen.size });
      }

      for (const filePath of mediaPaths) {
        fs.unlinkSync(filePath);
      }

      await delay(3000);
    } catch (err) {
      recordRepostFailure({
        sourceUsername: username,
        sourcePostId: post.id,
        sourcePostUrl: post.url,
        repostText: post.text || '',
        error: err.message,
      });
      addLog('error', `Failed to repost @${username}/${post.id}: ${err.message}`);
      console.error(`Failed to repost @${username}/${post.id}:`, err.message);
    }
  }
}

async function monitor() {
  createDashboardServer(DASHBOARD_PORT);
  initSourceAccounts(MONITORED_ACCOUNTS);
  setPollInterval(POLL_INTERVAL_MS);
  setMonitorStatus('starting');

  let repostProfiles = [];

  if (isKameleoEnabled()) {
    try {
      await checkKameleoHealth();
      repostProfiles = await syncKameleoDashboardAccounts();
      addLog('success', `Kameleo: ${repostProfiles.length} repost profile(s) loaded`);
      addLog('info', `Scanner profile: ${SCANNER_PROFILE_ID}`);
    } catch (err) {
      addLog('warn', `Kameleo unavailable: ${err.message}. Posting needs Kameleo CLI at ${process.env.KAMELEO_API_URL || 'http://localhost:5050'}`);
    }
  }

  const context = await getScannerContext();
  const page = await context.newPage();
  const collector = createGraphQLCollector(page);

  addLog('success', `Monitoring ${MONITORED_ACCOUNTS.map((u) => `@${u}`).join(', ')}`);
  addLog('info', `${repostProfiles.length} Kameleo repost profile(s)`);
  addLog('info', `Poll interval: ${POLL_INTERVAL_MS / 60000} minutes`);
  setMonitorStatus('idle');

  while (true) {
    markCheckStart();

    for (const username of MONITORED_ACCOUNTS) {
      try {
        await checkAccount(page, username, collector);
      } catch (err) {
        updateSourceAccountError(username, err.message);
        addLog('error', `Error checking @${username}: ${err.message}`);
        console.error(`Error checking @${username}:`, err.message);
      }
    }

    if (isKameleoEnabled()) {
      try {
        repostProfiles = await syncKameleoDashboardAccounts();
        for (const profile of repostProfiles) {
          if (!isPostingAllowed(profile.username)) continue;
          try {
            await refreshPostingAccountProfile(page, profile.username, collector);
          } catch (err) {
            updatePostingAccount(profile.username, {
              status: 'stalled',
              lastError: err.message,
            });
            addLog('warn', `Could not refresh @${profile.username}: ${err.message}`);
          }
        }
      } catch (err) {
        addLog('warn', `Could not sync Kameleo profiles: ${err.message}`);
      }
    }

    const nextCheckAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
    markCheckEnd(nextCheckAt);
    addLog('info', `Next check in ${POLL_INTERVAL_MS / 60000} minutes`);
    await delay(POLL_INTERVAL_MS);
  }
}

monitor().catch((err) => {
  setMonitorStatus('error');
  addLog('error', `Monitor crashed: ${err.message}`);
  console.error('Monitor error:', err);
  process.exit(1);
});

