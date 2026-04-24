require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { handleNewPost } = require('./handler');
const webhookServer = require('./webhook-server');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const WATCHED_CHANNELS = {
  [process.env.BUG_REPORT_CHANNEL_ID]: 'bug',
  [process.env.SUGGESTIONS_CHANNEL_ID]: 'suggestion',
};

client.once(Events.ClientReady, (c) => {
  console.log(`DevTrack Bot online as ${c.user.tag}`);
  console.log(`Watching channels:`);
  console.log(`  Bug Reports  → ${process.env.BUG_REPORT_CHANNEL_ID}`);
  console.log(`  Suggestions  → ${process.env.SUGGESTIONS_CHANNEL_ID}`);
  console.log(`  API          → ${process.env.API_URL}`);

  // Start webhook server once Discord is ready
  webhookServer.start();
});

// Fires when a new thread (forum post) is created
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated) return;

  const parentId = thread.parentId;
  const reportType = WATCHED_CHANNELS[parentId];
  if (!reportType) return;

  console.log(`[ThreadCreate] New ${reportType} post: "${thread.name}" in channel ${parentId}`);

  // Initial delay to let Discord populate the starter message
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
    await handleNewPost({ thread, starterMessage, reportType });
  } catch (err) {
    console.error(`[ThreadCreate] Failed to handle post "${thread.name}":`, err);
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Failed to login to Discord:', err.message);
  process.exit(1);
});
