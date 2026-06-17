const axios = require('axios');
const FormData = require('form-data');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { logMessage, getAttachments } = require('./message-logger');

const API_URL    = process.env.API_URL    || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const NOTIFY_EMOJI = '✅';

// Tracks pending retries so the button interaction can find the data
// Map<threadId, { thread, starterMessage, reportType, failMsg, lastAttempt }>
const pendingRetries = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────

function buildAttachmentList(message) {
  if (!message?.attachments?.size) return [];
  return [...message.attachments.values()].map(att => ({
    url: att.url,
    filename: att.name,
    contentType: att.contentType || 'application/octet-stream',
    size: att.size || 0,
  }));
}

function buildForm({ thread, starterMessage, reportType }) {
  const content     = starterMessage?.content || '';
  const discordUser = starterMessage?.author?.tag || 'unknown';
  const channelName = thread.parent?.name || 'unknown';
  const attachments = buildAttachmentList(starterMessage);

  const form = new FormData();
  form.append('type',            reportType);
  form.append('title',           thread.name);
  form.append('description',     content || '(No description provided)');
  form.append('priority',        'medium');
  form.append('discordUser',     discordUser);
  form.append('discordUserId',   starterMessage?.author?.id || '');
  form.append('discordThreadId', thread.id);
  form.append('discordChannel',  `#${channelName}`);
  form.append('discordMessageId', starterMessage?.id || thread.id);
  if (attachments.length > 0) {
    form.append('attachmentUrls', JSON.stringify(attachments));
  }
  return form;
}

async function submitReport(form) {
  const response = await axios.post(`${API_URL}/api/bot/report`, form, {
    headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
    timeout: 30000,
  });
  return response.data.reportId;
}

async function onSuccess({ reportId, thread, starterMessage, reportType }) {
  const discordUser   = starterMessage?.author?.tag || 'unknown';
  const discordUserId = starterMessage?.author?.id  || '';

  console.log(`[Handler] Report created: ID ${reportId}`);

  await logMessage({
    reportId,
    content:      starterMessage?.content || '(No description provided)',
    authorName:   discordUser,
    authorId:     discordUserId,
    authorAvatar: starterMessage?.author?.displayAvatarURL?.() || null,
    attachments:  getAttachments(starterMessage),
    isBot:        false,
  });

  const confirmMsg = await thread.send(
    reportType === 'suggestion'
      ? `> 💡 **Suggestion received.** Thank you for the feedback — the engineers will review this shortly.\n> React with ✅ below to get pinged when there's an update.`
      : `> 🐛 **Bug report received.** Thank you for reporting — the engineers will get to this shortly.\n> React with ✅ below to get pinged when there's an update.`
  ).catch(err => {
    console.error(`[Handler] Failed to send receipt message in thread ${thread.id}:`, err.message);
    return null;
  });

  if (confirmMsg) {
    await confirmMsg.react(NOTIFY_EMOJI).catch(() => {});

    const filter = (reaction, user) =>
      reaction.emoji.name === NOTIFY_EMOJI && user.id === starterMessage?.author?.id;

    const collector = confirmMsg.createReactionCollector({ filter, max: 1, time: 7 * 24 * 60 * 60 * 1000 });

    collector.on('collect', async () => {
      console.log(`[Handler] ${discordUser} opted in to notifications for report ${reportId}`);
      await axios.patch(`${API_URL}/api/bot/report/${reportId}`, { notifyOwner: true }, {
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      }).catch(e => console.error('[Handler] Failed to set notifyOwner:', e.message));
      await confirmMsg.reply(`Got it <@${discordUserId}> — you'll be pinged when engineers update this report.`).catch(() => {});
    });
  }

  pendingRetries.delete(thread.id);
  return reportId;
}

// ── Auto-retry with backoff: 5s → 15s → 30s ──────────────────────────────────

const RETRY_DELAYS = [5000, 15000, 30000];

async function attemptWithRetry({ thread, starterMessage, reportType }) {
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1];
      console.log(`[Handler] Retrying "${thread.name}" in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1})…`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const form     = buildForm({ thread, starterMessage, reportType });
      const reportId = await submitReport(form);
      return await onSuccess({ reportId, thread, starterMessage, reportType });
    } catch (err) {
      if (err.response?.status === 409) {
        console.log(`[Handler] Skipped duplicate: "${thread.name}"`);
        return null;
      }
      lastErr = err;
      console.warn(`[Handler] Attempt ${attempt + 1} failed for "${thread.name}":`, err.response?.data || err.message);
    }
  }

  // All auto-retries exhausted — post failure message with Retry button
  console.error(`[Handler] All retries exhausted for "${thread.name}"`);

  const retryBtn = new ButtonBuilder()
    .setCustomId(`retry_report:${thread.id}`)
    .setLabel('🔄 Retry')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(retryBtn);

  const failMsg = await thread.send({
    content: `> ⚠️ **DevTrack couldn't log this report after 3 attempts.** The backend may be temporarily down.\n> Click **Retry** to try again (1 attempt per minute).`,
    components: [row],
  }).catch(() => null);

  pendingRetries.set(thread.id, {
    thread,
    starterMessage,
    reportType,
    failMsg,
    lastAttempt: Date.now(),
  });

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function handleNewPost({ thread, starterMessage, reportType, client }) {
  console.log(`[Handler] Processing: "${thread.name}"`);
  console.log(`  Type:        ${reportType}`);
  console.log(`  Attachments: ${buildAttachmentList(starterMessage).length}`);
  console.log(`  Author:      ${starterMessage?.author?.tag || 'unknown'}`);

  return attemptWithRetry({ thread, starterMessage, reportType });
}

// ── Button interaction handler ────────────────────────────────────────────────

const RETRY_COOLDOWN_MS = 60 * 1000; // 1 minute

async function handleRetryButton(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId?.startsWith('retry_report:')) return false;

  const threadId = interaction.customId.split(':')[1];
  const pending  = pendingRetries.get(threadId);

  if (!pending) {
    await interaction.reply({
      content: '❌ No pending retry found. Try `/reopen` instead.',
      ephemeral: true,
    });
    return true;
  }

  const elapsed = Date.now() - pending.lastAttempt;
  if (elapsed < RETRY_COOLDOWN_MS) {
    const remaining = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
    await interaction.reply({
      content: `⏳ Please wait **${remaining}s** before retrying again.`,
      ephemeral: true,
    });
    return true;
  }

  pending.lastAttempt = Date.now();
  await interaction.reply({ content: '🔄 Retrying…', ephemeral: true });

  try {
    const form     = buildForm(pending);
    const reportId = await submitReport(form);

    if (pending.failMsg?.edit) {
      await pending.failMsg.edit({
        content: `> ✅ **Report successfully logged on retry.**`,
        components: [],
      }).catch(() => {});
    }

    await onSuccess({ reportId, thread: pending.thread, starterMessage: pending.starterMessage, reportType: pending.reportType });
    await interaction.editReply({ content: `✅ Report logged successfully!` });

  } catch (err) {
    if (err.response?.status === 409) {
      pendingRetries.delete(threadId);
      if (pending.failMsg?.edit) {
        await pending.failMsg.edit({ content: `> ✅ Report already exists in DevTrack.`, components: [] }).catch(() => {});
      }
      await interaction.editReply({ content: '✅ Report already exists in DevTrack.' });
      return true;
    }
    console.error('[Handler] Manual retry failed:', err.response?.data || err.message);
    await interaction.editReply({
      content: `❌ Still failing: \`${err.response?.data?.message || err.message}\`\nTry again in a minute or use \`/reopen\` once the backend is back up.`,
    });
  }

  return true;
}

module.exports = { handleNewPost, handleRetryButton, pendingRetries };
