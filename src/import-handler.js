const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

function buildAttachmentList(message) {
  if (!message?.attachments?.size) return [];
  return [...message.attachments.values()].map(att => ({
    url: att.url,
    filename: att.name || 'import-file',
    contentType: att.contentType || 'application/octet-stream',
    size: att.size || 0,
  }));
}

async function handleImportMessage(message) {
  const attachments = buildAttachmentList(message);
  if (!attachments.length) return null;

  const payload = {
    title: message.content?.split('\n').find(Boolean)?.slice(0, 120) || attachments[0].filename || 'Import request',
    description: message.content || '',
    discordUser: message.author?.tag || 'unknown',
    discordUserId: message.author?.id || '',
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    attachments,
  };

  const response = await axios.post(`${API_URL}/api/imports/bot`, payload, {
    headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
    timeout: 120000,
  });

  return response.data.importId;
}

module.exports = {
  handleImportMessage,
};
