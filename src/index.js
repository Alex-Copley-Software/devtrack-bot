require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleNewPost } = require('./handler');
const { logMessage, getAttachments } = require('./message-logger');
const webhookServer = require('./webhook-server');
const axios = require('axios');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const WATCHED_CHANNELS = {
  [process.env.BUG_REPORT_CHANNEL_ID]: 'bug',
  [process.env.SUGGESTIONS_CHANNEL_ID]: 'suggestion',
};

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

// Cache threadId -> reportId so we can log messages
const threadReportMap = new Map();

client.once(Events.ClientReady, (c) => {
  console.log(`DevTrack Bot online as ${c.user.tag}`);
  console.log(`Watching channels:`);
  console.log(`  Bug Reports  → ${process.env.BUG_REPORT_CHANNEL_ID}`);
  console.log(`  Suggestions  → ${process.env.SUGGESTIONS_CHANNEL_ID}`);
  console.log(`  API          → ${process.env.API_URL}`);
  webhookServer.start();
});

// New forum post created
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated) return;
  const parentId = thread.parentId;
  const reportType = WATCHED_CHANNELS[parentId];
  if (!reportType) return;

  console.log(`[ThreadCreate] New ${reportType} post: "${thread.name}" in channel ${parentId}`);
  await new Promise((r) => setTimeout(r, 3000));

  let starterMessage = null;
  for (let i = 0; i < 3; i++) {
    try {
      starterMessage = await thread.fetchStarterMessage({ cache: false });
      break;
    } catch {
      console.log(`[ThreadCreate] Starter message not ready, retrying (${i + 1}/3)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!starterMessage) {
    console.error(`[ThreadCreate] Could not fetch starter message for "${thread.name}" after 3 attempts — skipping.`);
    return;
  }

  try {
    const reportId = await handleNewPost({ thread, starterMessage, reportType, client });
    if (reportId) {
      // Cache the mapping so future messages can be logged
      threadReportMap.set(thread.id, reportId);
      console.log(`[ThreadCreate] Cached thread ${thread.id} → report ${reportId}`);
    }
  } catch (err) {
    console.error(`[ThreadCreate] Failed to handle post "${thread.name}":`, err);
  }
});

// New message in any thread
client.on(Events.MessageCreate, async (message) => {
  // Ignore DMs and non-thread messages
  if (!message.channel?.isThread()) return;
  // Ignore the bot's own messages
  if (message.author.bot) return;

  const thread = message.channel;
  const parentId = thread.parentId;

  // Only care about our watched forum channels
  if (!WATCHED_CHANNELS[parentId]) return;

  const threadId = thread.id;

  // Look up reportId from cache or fetch from backend
  let reportId = threadReportMap.get(threadId);

  if (!reportId) {
    // Try to find the report by threadId from the backend
    try {
      const TOKEN = process.env.BOT_SECRET;
      const res = await axios.get(`${API_URL}/api/reports?discordThreadId=${threadId}`, {
        headers: { 'x-bot-secret': BOT_SECRET },
        timeout: 5000,
      });
      // Find matching report
      const match = (res.data || []).find(r => r.discordThreadId === threadId);
      if (match) {
        reportId = match.id;
        threadReportMap.set(threadId, reportId);
      }
    } catch (err) {
      console.error(`[MessageCreate] Could not look up report for thread ${threadId}:`, err.message);
    }
  }

  if (!reportId) {
    console.log(`[MessageCreate] No report found for thread ${threadId} — skipping`);
    return;
  }

  console.log(`[MessageCreate] Logging message from ${message.author.tag} in thread ${threadId}`);

  await logMessage({
    reportId,
    content: message.content || '(attachment only)',
    authorName: message.author.tag,
    authorId: message.author.id,
    authorAvatar: message.author.displayAvatarURL() || null,
    attachments: getAttachments(message),
    isBot: false,
  });
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Failed to login to Discord:', err.message);
  process.exit(1);
});