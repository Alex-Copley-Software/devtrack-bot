require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const SUGGESTION_CHANNEL = process.env.CHANNEL_CONFIG 
  ? JSON.parse(process.env.CHANNEL_CONFIG).find(c => c.type === 'suggestion')?.id
  : process.env.SUGGESTIONS_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Bot ready: ${client.user.tag}`);
  console.log(`Checking channel: ${SUGGESTION_CHANNEL}`);

  try {
    const channel = await client.channels.fetch(SUGGESTION_CHANNEL);
    console.log(`Channel: ${channel.name}`);

    const active = await channel.threads.fetchActive();
    const threads = [...active.threads.values()].slice(0, 3);
    console.log(`Checking first ${threads.length} threads...\n`);

    for (const thread of threads) {
      console.log(`Thread: "${thread.name}" (${thread.id})`);
      try {
        const starter = await thread.fetchStarterMessage({ cache: false });
        console.log(`  Starter ID: ${starter.id}`);

        // Fetch via messages API to get reactions
        const freshMsg = await thread.messages.fetch(starter.id);
        console.log(`  Reaction count on message: ${freshMsg.reactions.cache.size} types`);
        freshMsg.reactions.cache.forEach((r, key) => {
          console.log(`  Reaction: ${r.emoji.name} x${r.count}`);
        });

        const star = freshMsg.reactions.cache.get('⭐');
        console.log(`  ⭐ count: ${star?.count ?? 'NOT FOUND'}\n`);
      } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
      }
    }
  } catch (err) {
    console.error('Failed:', err.message);
  }

  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);