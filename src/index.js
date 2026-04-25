require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleNewPost } = require('./handler');
const { logMessage, getAttachments } = require('./message-logger');
const webhookServer = require('./webhook-server');

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

// Cache threadId -> reportId so we can log messages without extra API calls
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
    console.error(`[ThreadCreate] Could not fetch starter message for "${thread.name}" — skipping.`);
    return;
  }

  try {
    const reportId = await handleNewPost({ thread, starterMessage, reportType, client });
    if (reportId) {
      threadReportMap.set(thread.id, reportId);
      console.log(`[ThreadCreate] Cached thread ${thread.id} → report ${reportId}`);
    }
  } catch (err) {
    console.error(`[ThreadCreate] Failed to handle post "${thread.name}":`, err);
  }
});

// New message posted in a tracked thread
client.on(Events.MessageCreate, async (message) => {
  if (!message.channel?.isThread()) return;
  if (message.author.bot) return;

  const thread = message.channel;
  const parentId = thread.parentId;
  if (!WATCHED_CHANNELS[parentId]) return;

  const threadId = thread.id;

  // Only log if we have the report cached — avoids race condition on first message
  const reportId = threadReportMap.get(threadId);
  if (!reportId) {
    console.log(`[MessageCreate] Thread ${threadId} not in cache — skipping (starter message already logged)`);
    return;
  }

  console.log(`[MessageCreate] Logging reply from ${message.author.tag} in thread ${threadId}`);

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