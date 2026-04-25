// message-logger.js
// Sends Discord thread messages to the backend for storage

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

async function logMessage({ reportId, content, authorName, authorId, authorAvatar, attachments, isBot }) {
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

module.exports = { logMessage, getAttachments };