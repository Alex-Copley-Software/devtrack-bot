// sync-report-command.js
// /syncreport — run inside a forum thread that never got tracked (bot
// downtime, channel added after the fact, etc). Creates a DevTrack report
// from the thread's starter post and backfills its message history. If a
// report already exists for the thread, links it and logs any replies it is
// missing. The forum sweep (forum-sync.js) does both on its own every few
// minutes, so this is rarely needed.

const axios = require('axios');
const tickets = require('./tickets');
const FormData = require('form-data');
const { logMessage, fromMessage } = require('./message-logger');
const forumSync = require('./forum-sync');
const { devTagsFor } = require('./dev-tags');

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

async function handleSyncReport(interaction, WATCHED_CHANNELS, threadReportMap) {
  const thread = interaction.channel;

  const reportType = tickets.reportTypeFor(thread, WATCHED_CHANNELS);
  if (!reportType) {
    return interaction.reply({
      content: '❌ This command can only be used inside a tracked forum thread or a bug ticket.',
      ephemeral: true,
    });
  }
  const isTicket = !thread.isThread();

  await interaction.deferReply({ ephemeral: true });

  // ── 1. Already tracked? Just link it, don't duplicate ─────────────────────
  let report = await lookupByThread(thread.id);
  if (!report) {
    const cachedId = threadReportMap.get(thread.id);
    if (cachedId) report = { id: cachedId };
  }
  if (!report) {
    const starter = isTicket ? null : await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (starter) report = await lookupByMessage(starter.id);
  }
  if (report) {
    threadReportMap.set(thread.id, report.id);
    // Catch up on replies it is missing, from the newest one it has.
    let caughtUp = 0;
    if (!isTicket) {
      try {
        const known = (await axios.post(`${API_URL}/api/bot/thread-sync`, { threads: [{ threadId: thread.id, title: thread.name }] }, {
          headers: { 'x-bot-secret': BOT_SECRET }, timeout: 15000,
        })).data.reports[thread.id];
        if (known?.lastMessageId) caughtUp = await forumSync.backfill(thread, report.id, known.lastMessageId);
      } catch (err) {
        console.error('[SyncReport] Could not catch up on replies:', err.response?.data || err.message);
      }
    }
    return interaction.editReply({
      content: `🔗 **This thread is already tracked in DevTrack.**${caughtUp ? ` ${caughtUp} missed message${caughtUp === 1 ? '' : 's'} logged.` : ''}\n${dashboardLink(report.id)}`,
    });
  }

  // ── 2. Not tracked — create it from the starter post ───────────────────────
  // Bug reports are forum posts again; a ticket with no report stays untracked.
  if (isTicket) {
    return interaction.editReply({
      content: '❌ New tickets are not logged in DevTrack any more. Ask the reporter to post it in the bug reports forum.',
    });
  }

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
  const tags = devTagsFor(thread);
  if (tags.length) form.append('devTags', JSON.stringify(tags));

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
  await logMessage(fromMessage(starterMessage, reportId, '(No description provided)'));

  let logged = 1;
  try {
    logged += await forumSync.backfill(thread, reportId, starterMessage.id);
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
