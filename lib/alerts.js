const nodemailer = require('nodemailer');

function buildAlertPayload(job) {
  const text = job.repostText || job.textPreview || '';
  return {
    title: `New thread from @${job.sourceUsername}`,
    sourceUsername: job.sourceUsername,
    sourcePostUrl: job.sourcePostUrl,
    sourcePostId: job.sourcePostId,
    topic: job.topic || null,
    textPreview: text.slice(0, 500),
    detectedAt: new Date().toISOString(),
    sourcePostAt: job.sourcePostAt || null,
    mediaCount: job.mediaPaths?.length || 0,
  };
}

function formatSlackBlocks(payload) {
  const lines = [
    `*New thread from @${payload.sourceUsername}*`,
    payload.topic ? `*Topic:* ${payload.topic}` : null,
    payload.textPreview ? `\n${payload.textPreview}` : null,
    `<${payload.sourcePostUrl}|Open on Threads>`,
  ].filter(Boolean);

  return {
    text: payload.title,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
    ],
  };
}

async function sendSlack(payload) {
  const url = process.env.ALERT_SLACK_WEBHOOK_URL;
  if (!url) return null;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formatSlackBlocks(payload)),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack alert failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return 'slack';
}

async function sendGenericWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return null;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook alert failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return 'webhook';
}

function getMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !process.env.ALERT_EMAIL_TO) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
}

async function sendEmail(payload) {
  const mailer = getMailer();
  if (!mailer) return null;

  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || 'threads-monitor@localhost';

  const lines = [
    `New thread from @${payload.sourceUsername}`,
    '',
    payload.topic ? `Topic: ${payload.topic}` : null,
    '',
    payload.textPreview || '(no text)',
    '',
    `Link: ${payload.sourcePostUrl}`,
    `Post ID: ${payload.sourcePostId}`,
    `Detected: ${payload.detectedAt}`,
  ].filter((line) => line !== null);

  await mailer.sendMail({
    from,
    to,
    subject: `[Threads] New post from @${payload.sourceUsername}`,
    text: lines.join('\n'),
  });

  return 'email';
}

async function sendNewThreadAlert(job) {
  const payload = buildAlertPayload(job);
  const channels = [];

  const slack = await sendSlack(payload);
  if (slack) channels.push(slack);

  const webhook = await sendGenericWebhook(payload);
  if (webhook) channels.push(webhook);

  const email = await sendEmail(payload);
  if (email) channels.push(email);

  if (!channels.length) {
    return { channels: ['dashboard'], payload };
  }

  return { channels, payload };
}

function listConfiguredChannels() {
  const channels = [];
  if (process.env.ALERT_SLACK_WEBHOOK_URL) channels.push('slack');
  if (process.env.ALERT_WEBHOOK_URL) channels.push('webhook');
  if (process.env.SMTP_HOST && process.env.ALERT_EMAIL_TO) channels.push('email');
  return channels;
}

module.exports = {
  sendNewThreadAlert,
  listConfiguredChannels,
};
