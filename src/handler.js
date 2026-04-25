const axios = require('axios');
const FormData = require('form-data');
const { logMessage, getAttachments } = require('./message-logger');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const NOTIFY_EMOJI = '✅';

// Build the list of Discord attachment URLs to pass to the API
function buildAttachmentList(message) {
  if (!message || !message.attachments || message.attachments.size === 0) return [];
  return [...message.attachments.values()].map((att) => ({
    url: att.url,
    filename: att.name,
    contentType: att.contentType || 'application/octet-stream',
  }));
}

async function handleNewPost({ thread, starterMessage, reportType, client }) {
  const title = thread.name;
  const content = starterMessage?.content || '';
  const discordUser = starterMessage?.author?.tag || 'unknown';
  const discordUserId = starterMessage?.author?.id || '';
  const discordThreadId = thread.id || '';
  const discordMessageId = starterMessage?.id || thread.id;
  const channelName = thread.parent?.name || 'unknown';
  const attachments = buildAttachmentList(starterMessage);

  console.log(`[Handler] Processing: "${title}"`);
  console.log(`  Type:        ${reportType}`);
  console.log(`  Attachments: ${attachments.length}`);
  console.log(`  Author:      ${discordUser}`);

  const form = new FormData();
  form.append('type', reportType);
  form.append('title', title);
  form.append('description', content || '(No description provided)');
  form.append('priority', 'medium');
  form.append('discordUser', discordUser);
  form.append('discordUserId', discordUserId);
  form.append('discordThreadId', discordThreadId);
  form.append('discordChannel', `#${channelName}`);
  form.append('discordMessageId', discordMessageId);

  if (attachments.length > 0) {
    form.append('attachmentUrls', JSON.stringify(attachments));
  }

  try {
    const response = await axios.post(`${API_URL}/api/bot/report`, form, {
      headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
      timeout: 30000,
    });

    const reportId = response.data.reportId;
    console.log(`[Handler] Report created: ID ${reportId}`);

    // Log the starter message to the conversation log
    await logMessage({
      reportId,
      content: content || '(No description provided)',
      authorName: discordUser,
      authorId: starterMessage?.author?.id || '',
      authorAvatar: starterMessage?.author?.displayAvatarURL?.() || null,
      attachments: getAttachments(starterMessage),
      isBot: false,
    });

    // Post confirmation message
    const confirmMsg = await thread.send(
      reportType === 'suggestion'
        ? `> 💡 **Suggestion received.** Thank you for the feedback — the engineers will review this shortly.\n> React with ✅ below to get pinged when there's an update.`
        : `> 🐛 **Bug report received.** Thank you for reporting — the engineers will get to this shortly.\n> React with ✅ below to get pinged when there's an update.`
    ).catch(() => null);

    // Bot reacts with ✅ on the confirmation message to make it easy to click
    if (confirmMsg) {
      await confirmMsg.react(NOTIFY_EMOJI).catch(() => {});

      // Watch for the OP to react — if they do, mark them as opted in
      const filter = (reaction, user) =>
        reaction.emoji.name === NOTIFY_EMOJI &&
        user.id === starterMessage?.author?.id;

      const collector = confirmMsg.createReactionCollector({ filter, max: 1, time: 7 * 24 * 60 * 60 * 1000 }); // 7 days

      collector.on('collect', async () => {
        console.log(`[Handler] ${discordUser} opted in to notifications for report ${reportId}`);
        // Update report to mark user as opted in
        await axios.patch(`${API_URL}/api/bot/report/${reportId}`, { notifyOwner: true }, {
          headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
        }).catch(e => console.error('[Handler] Failed to set notifyOwner:', e.message));

        await confirmMsg.reply(`Got it <@${discordUserId}> — you'll be pinged when engineers update this report.`).catch(() => {});
      });
    }

    return reportId;

  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`[Handler] Skipped duplicate: "${title}"`);
      return null;
    }
    console.error(`[Handler] Failed to submit report "${title}":`, err.response?.data || err.message);
    await thread.send('> ⚠️ DevTrack Bot had trouble logging this report. An engineer has been notified.').catch(() => {});
    return null;
  }
}

module.exports = { handleNewPost };