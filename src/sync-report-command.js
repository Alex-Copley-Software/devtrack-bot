// sync-report-command.js
// /syncreport — run inside a forum thread that never got tracked (bot
// downtime, channel added after the fact, etc). Creates a DevTrack report
// from the thread's starter post and backfills its message history. If a
// report already exists for the thread, just links it instead of
// duplicating.

const axios = require('axios');
const FormData = require('form-data');
const { logMessage, getAttachments } = require('./message-logger');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';

function buildAttachmentList(message) {
  if (!message?.attachments?.size) return [];
  return [...message.attachments.values()].map(att => ({
    url: att.url,
    filename: att.name,
    contentType: att.contentType || 'application/octet-stream',
  }));
}

async function lookupByThread(threadId) {
  try {
    const r = await axios.get(`${API_URL}/api/bot/report-by-thread/${threadId}`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    return r.data?.report || (r.data?.reportId ? { id: r.data.reportId } : null);
  } catch { return null; }
}

async function lookupByMessage(messageId) {
  try {
    const r = await axios.get(`${API_URL}/api/bot/report-by-message/${messageId}`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    return r.data?.report || (r.data?.reportId ? { id: r.data.reportId } : null);
  } catch { return null; }
}

function dashboardLink(reportId) {
  return `${DASHBOARD}#report/${reportId}`;
}

// Fetch ALL messages in the thread oldest-first (handles pagination)
async function fetchAllMessages(thread) {
  const all = [];
  let before = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const opts = { limit: 100 };
    if (before) opts.before = before;
    const batch = await thread.messages.fetch(opts);
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function handleSyncReport(interaction, WATCHED_CHANNELS, threadReportMap) {
  const thread = interaction.channel;

  if (!thread?.isThread()) {
    return interaction.reply({
      content: '❌ This command can only be used inside a forum thread.',
      ephemeral: true,
    });
  }

  const parentId = thread.parentId;
  const reportType = WATCHED_CHANNELS[parentId];
  if (!reportType) {
    return interaction.reply({
      content: '❌ This thread is not in a tracked DevTrack channel.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // ── 1. Already tracked? Just link it, don't duplicate ─────────────────────
  let report = await lookupByThread(thread.id);
  if (!report) {
    const cachedId = threadReportMap.get(thread.id);
    if (cachedId) report = { id: cachedId };
  }
  if (!report) {
    const starter = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (starter) report = await lookupByMessage(starter.id);
  }
  if (report) {
    threadReportMap.set(thread.id, report.id);
    return interaction.editReply({
      content: `🔗 **This thread is already tracked in DevTrack.**\n${dashboardLink(report.id)}`,
    });
  }

  // ── 2. Not tracked — create it from the starter post ───────────────────────
  console.log(`[SyncReport] No report found for thread ${thread.id} — creating one`);

  let starterMessage = null;
  const delays = [1000, 2000, 4000];
  for (const delay of delays) {
    starterMessage = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (starterMessage) break;
    await new Promise(r => setTimeout(r, delay));
  }
  if (!starterMessage) {
    const msgs = await thread.messages.fetch({ limit: 5 }).catch(() => null);
    starterMessage = msgs?.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first() || null;
  }
  if (!starterMessage) {
    return interaction.editReply({
      content: '❌ Could not fetch the original post content. Please try again in a moment.',
    });
  }

  const form = new FormData();
  form.append('type', reportType);
  form.append('title', thread.name);
  form.append('description', starterMessage.content || '(No description provided)');
  form.append('priority', 'medium');
  form.append('discordUser', starterMessage.author?.tag || 'unknown');
  form.append('discordUserId', starterMessage.author?.id || '');
  form.append('discordThreadId', thread.id);
  form.append('discordChannel', `#${thread.parent?.name || 'unknown'}`);
  form.append('discordMessageId', starterMessage.id);
  const attachments = buildAttachmentList(starterMessage);
  if (attachments.length > 0) form.append('attachmentUrls', JSON.stringify(attachments));

  let reportId;
  try {
    const res = await axios.post(`${API_URL}/api/bot/report`, form, {
      headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
      timeout: 30000,
    });
    reportId = res.data.reportId;
    console.log(`[SyncReport] Created report ${reportId} for thread ${thread.id}`);
  } catch (err) {
    if (err.response?.status === 409) {
      const retry = await lookupByThread(thread.id);
      if (retry) {
        threadReportMap.set(thread.id, retry.id);
        return interaction.editReply({
          content: `🔗 **Already tracked.**\n${dashboardLink(retry.id)}`,
        });
      }
    }
    console.error('[SyncReport] Failed to create report:', err.response?.data || err.message);
    return interaction.editReply({
      content: '❌ Failed to create the report. Please check the bot logs.',
    });
  }

  threadReportMap.set(thread.id, reportId);

  // ── 3. Log starter post + backfill any replies ─────────────────────────────
  await logMessage({
    reportId,
    content: starterMessage.content || '(No description provided)',
    authorName: starterMessage.author?.tag || 'unknown',
    authorId: starterMessage.author?.id || '',
    authorAvatar: starterMessage.author?.displayAvatarURL?.() || null,
    attachments: getAttachments(starterMessage),
    isBot: false,
  });

  let logged = 1;
  try {
    const allMessages = await fetchAllMessages(thread);
    for (const msg of allMessages) {
      if (msg.id === starterMessage.id) continue;
      if (msg.author?.bot) continue;
      if (!msg.content && !msg.attachments?.size) continue;
      await logMessage({
        reportId,
        content: msg.content || '(attachment only)',
        authorName: msg.author?.tag || 'unknown',
        authorId: msg.author?.id || '',
        authorAvatar: msg.author?.displayAvatarURL?.() || null,
        attachments: getAttachments(msg),
        isBot: false,
      });
      logged++;
      await new Promise(r => setTimeout(r, 150));
    }
  } catch (err) {
    console.error('[SyncReport] Failed to backfill messages:', err.message);
  }

  // ── 4. Reply ─────────────────────────────────────────────────────────────
  const link = dashboardLink(reportId);
  await interaction.editReply({
    content: [
      `✅ **Report added to DevTrack.**`,
      `> ${logged} message${logged !== 1 ? 's' : ''} imported into the conversation log.`,
      `> ${link}`,
    ].join('\n'),
  });

  await thread.send(
    `> ➕ **This thread was synced to DevTrack** by <@${interaction.user.id}> — it had been missed by automatic tracking.\n> ${link}`
  ).catch(() => {});
}

module.exports = { handleSyncReport };
