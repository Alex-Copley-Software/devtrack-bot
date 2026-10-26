// message-logger.js
// Sends Discord thread messages to the backend for storage. With the Discord
// message id the backend skips one it already has, so catching up on missed
// messages (forum-sync.js) never logs anything twice.

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

async function logMessage({ reportId, content, authorName, authorId, authorAvatar, attachments, isBot, discordMessageId, sentAt }) {
  if (!reportId || !content) return;
  try {
    await axios.post(`${API_URL}/api/messages`, {
      reportId,
      content,
      authorName,
      authorId,
      authorAvatar,
      attachments: attachments || [],
      isBot: isBot || false,
      discordMessageId: discordMessageId || null,
      sentAt: sentAt || null,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });
    console.log(`[Logger] Message logged for report ${reportId}`);
  } catch (err) {
    console.error(`[Logger] Failed to log message:`, err.message);
  }
}

// Build attachment list from a Discord message
function getAttachments(message) {
  return [...(message.attachments?.values() || [])].map(a => a.url);
}

// Everything logMessage needs from a Discord message.
function fromMessage(message, reportId, fallback = '(attachment only)') {
  return {
    reportId,
    content: message.content || fallback,
    authorName: message.author?.tag || 'unknown',
    authorId: message.author?.id || '',
    authorAvatar: message.author?.displayAvatarURL?.() || null,
    attachments: getAttachments(message),
    isBot: false,
    discordMessageId: message.id || null,
    sentAt: message.createdAt?.toISOString?.() || null,
  };
}

module.exports = { logMessage, getAttachments, fromMessage };