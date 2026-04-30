// reopen-command.js
// /reopen — checks if the current thread has a DevTrack report:
//   • If it does → replies with the dashboard link
//   • If it doesn't → creates a fresh report, backfills all chat history, and links it

const axios   = require('axios');
const FormData = require('form-data');
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { logMessage, getAttachments } = require('./message-logger');

const API_URL    = process.env.API_URL    || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD  = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';
const STATUS_OPTIONS = [
  { label: 'Queued', value: 'queued', description: 'Move it back to the bug queue.' },
  { label: 'Open', value: 'open', description: 'Move it to active/open reports.' },
  { label: 'In Progress', value: 'in_progress', description: 'Move it to engineering work.' },
  { label: 'Reviewing', value: 'reviewing', description: 'Move it to QA review.' },
  { label: 'Resolved', value: 'resolved', description: 'Keep it resolved.' },
  { label: 'Declined', value: 'declined', description: 'Move it to declined reports.' },
];

function getCommandDefinition() {
  return {
    name: 'reopen',
    description: 'Re-open or locate the DevTrack report for this thread',
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function buildResolvedStatusRow(reportId, userId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`reopen_status:${reportId}:${userId}`)
    .setPlaceholder('Move resolved report to...')
    .addOptions(STATUS_OPTIONS);

  return new ActionRowBuilder().addComponents(menu);
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
    await new Promise(r => setTimeout(r, 300)); // be kind to the API
  }

  // Sort oldest → newest
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// ── main handler ──────────────────────────────────────────────────────────────

async function handleReopen(interaction, WATCHED_CHANNELS, threadReportMap) {
  const thread = interaction.channel;

  // Must be run inside a thread
  if (!thread?.isThread()) {
    return interaction.reply({
      content: '❌ This command can only be used inside a forum thread.',
      ephemeral: true,
    });
  }

  const parentId   = thread.parentId;
  const reportType = WATCHED_CHANNELS[parentId];

  // Must be a watched channel
  if (!reportType) {
    return interaction.reply({
      content: '❌ This thread is not in a tracked DevTrack channel.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // ── 1. Check if report already exists ────────────────────────────────────

  let report = null;
  const cachedReportId = threadReportMap.get(thread.id);
  report = await lookupByThread(thread.id);
  if (!report && cachedReportId) report = { id: cachedReportId };

  // Also try by starter message ID as fallback
  if (!report) {
    const starter = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (starter) report = await lookupByMessage(starter.id);
  }

  if (report) {
    const link = dashboardLink(report.id);
    threadReportMap.set(thread.id, report.id);

    if (report.status === 'resolved') {
      return interaction.editReply({
        content: [
          `🔁 **This report is currently resolved.**`,
          `Do you want to move this report from **Resolved** to another status?`,
          link,
        ].join('\n'),
        components: [buildResolvedStatusRow(report.id, interaction.user.id)],
      });
    }

    return interaction.editReply({
      content: `🔗 **This thread already has a DevTrack report.**\n${link}`,
    });
  }

  // ── 2. No report found — create a fresh one ───────────────────────────────

  console.log(`[Reopen] No report found for thread ${thread.id} — creating new report`);

  // Fetch starter message with retries
  let starterMessage = null;
  const delays = [1000, 2000, 4000];
  for (const delay of delays) {
    starterMessage = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (starterMessage) break;
    await new Promise(r => setTimeout(r, delay));
  }

  // Fallback to first message in history
  if (!starterMessage) {
    const msgs = await thread.messages.fetch({ limit: 5 }).catch(() => null);
    starterMessage = msgs?.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first() || null;
  }

  if (!starterMessage) {
    return interaction.editReply({
      content: '❌ Could not fetch the original post content. Please try again in a moment.',
    });
  }

  const title       = thread.name;
  const content     = starterMessage.content || '(No description provided)';
  const discordUser = starterMessage.author?.tag || 'unknown';
  const discordUserId = starterMessage.author?.id || '';
  const channelName = thread.parent?.name || 'unknown';
  const attachments = buildAttachmentList(starterMessage);

  const form = new FormData();
  form.append('type',            reportType);
  form.append('title',           title);
  form.append('description',     content);
  form.append('priority',        'medium');
  form.append('discordUser',     discordUser);
  form.append('discordUserId',   discordUserId);
  form.append('discordThreadId', thread.id);
  form.append('discordChannel',  `#${channelName}`);
  form.append('discordMessageId', starterMessage.id);
  if (reportType === 'suggestion') {
    form.append('queued',  'false');
    form.append('status',  'open');
  }
  if (attachments.length > 0) {
    form.append('attachmentUrls', JSON.stringify(attachments));
  }

  let newReportId = null;
  try {
    const res = await axios.post(`${API_URL}/api/bot/report`, form, {
      headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
      timeout: 30000,
    });
    newReportId = res.data.reportId;
    console.log(`[Reopen] Created report ${newReportId} for thread ${thread.id}`);
  } catch (err) {
    if (err.response?.status === 409) {
      // Race condition — someone else created it, try lookup again
      const retryId = await lookupByThread(thread.id);
      if (retryId) {
        threadReportMap.set(thread.id, retryId.id);
        return interaction.editReply({
          content: `🔗 **Report already exists.**\n${dashboardLink(retryId.id)}`,
        });
      }
    }
    console.error('[Reopen] Failed to create report:', err.response?.data || err.message);
    return interaction.editReply({
      content: '❌ Failed to create the report. Please check the bot logs.',
    });
  }

  // Cache it
  threadReportMap.set(thread.id, newReportId);

  // ── 3. Backfill all thread messages into conversation history ─────────────

  console.log(`[Reopen] Backfilling chat history for report ${newReportId}…`);

  let allMessages = [];
  try {
    allMessages = await fetchAllMessages(thread);
  } catch (err) {
    console.error('[Reopen] Failed to fetch message history:', err.message);
  }

  let logged = 0;
  for (const msg of allMessages) {
    // Skip bot messages and empty ones
    if (msg.author?.bot) continue;
    if (!msg.content && !msg.attachments?.size) continue;

    await logMessage({
      reportId:    newReportId,
      content:     msg.content || '(attachment only)',
      authorName:  msg.author?.tag || 'unknown',
      authorId:    msg.author?.id  || '',
      authorAvatar: msg.author?.displayAvatarURL?.() || null,
      attachments: getAttachments(msg),
      isBot:       false,
    });
    logged++;
    await new Promise(r => setTimeout(r, 150)); // avoid hammering the API
  }

  console.log(`[Reopen] Backfilled ${logged} messages for report ${newReportId}`);

  // ── 4. Reply with the link ────────────────────────────────────────────────

  const link = dashboardLink(newReportId);

  await interaction.editReply({
    content: [
      `✅ **Report reopened on DevTrack.**`,
      `> ${logged} message${logged !== 1 ? 's' : ''} from this thread have been imported into the conversation log.`,
      `> ${link}`,
    ].join('\n'),
  });

  // Also post a visible note in the thread itself so others know
  await thread.send(
    `> 🔄 **This report has been re-opened on DevTrack** by <@${interaction.user.id}>.\n> ${link}`
  ).catch(() => {});
}

async function handleReopenStatusSelect(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!interaction.customId?.startsWith('reopen_status:')) return false;

  const [, reportId, allowedUserId] = interaction.customId.split(':');
  if (interaction.user.id !== allowedUserId) {
    await interaction.reply({
      content: 'Only the user who ran `/reopen` can choose this status.',
      ephemeral: true,
    });
    return true;
  }

  const status = interaction.values?.[0];
  if (!STATUS_OPTIONS.some(option => option.value === status)) {
    await interaction.reply({ content: 'Invalid status selected.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();

  try {
    await axios.patch(`${API_URL}/api/bot/report/${reportId}`, {
      status,
      actorName: interaction.user.tag || interaction.user.username,
      actorId: interaction.user.id,
      detail: `Moved from resolved to ${status} via Discord /reopen by ${interaction.user.tag || interaction.user.username}`,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });

    const selected = STATUS_OPTIONS.find(option => option.value === status);
    await interaction.editReply({
      content: [
        `✅ **Report moved from Resolved to ${selected?.label || status}.**`,
        dashboardLink(reportId),
      ].join('\n'),
      components: [],
    });
  } catch (err) {
    console.error('[Reopen] Failed to update resolved report status:', err.response?.data || err.message);
    await interaction.editReply({
      content: '❌ Failed to update the report status. Please check the bot logs.',
      components: [],
    });
  }

  return true;
}

module.exports = { getCommandDefinition, handleReopen, handleReopenStatusSelect };
