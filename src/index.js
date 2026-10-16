require('dotenv').config();
const axios = require('axios');
const { Client, GatewayIntentBits, Events, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { handleNewPost, handleRetryButton } = require('./handler');
const { logMessage, getAttachments } = require('./message-logger');
const webhookServer = require('./webhook-server');
const { handleImportMessage } = require('./import-handler');
const { handleSyncReport } = require('./sync-report-command');
const {
  getCommandDefinitions: creditCommandDefs,
  handleCredit,
  handleRequestCredit,
  handleCreditButton,
  escalateStaleCreditRequests,
} = require('./credit-commands');
const reportPause = require('./report-pause');
const assetAgent = require('./asset-agent');
const assetStatus = require('./asset-status');
const qaCheck = require('./qa-check');
const assetPayouts = require('./asset-payouts');
const { getCommandDefinitions: assetCommandDefs, handleAssets } = require('./assets-command');
const robloxConvert = require('./roblox-convert');

const CREDIT_ESCALATION_POLL_MS = 15 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages, // the owner's private DMs with the bot (see personal.js)
  ],
  partials: [Partials.Channel], // DM channels are not cached; without this their messages never arrive
});

// Support multiple channels via CHANNEL_CONFIG JSON or fallback to individual env vars
let WATCHED_CHANNELS = {};
if (process.env.CHANNEL_CONFIG) {
  try {
    const configs = JSON.parse(process.env.CHANNEL_CONFIG);
    configs.forEach(c => { WATCHED_CHANNELS[c.id] = c.type; });
    console.log(`[Config] Loaded ${configs.length} channels from CHANNEL_CONFIG`);
  } catch (e) {
    console.error('[Config] Failed to parse CHANNEL_CONFIG:', e.message);
  }
}
// Always include individual env vars as fallback/addition
if (process.env.BUG_REPORT_CHANNEL_ID) WATCHED_CHANNELS[process.env.BUG_REPORT_CHANNEL_ID] = 'bug';
if (process.env.SUGGESTIONS_CHANNEL_ID) WATCHED_CHANNELS[process.env.SUGGESTIONS_CHANNEL_ID] = 'suggestion';
if (process.env.IMPORTS_CHANNEL_ID) WATCHED_CHANNELS[process.env.IMPORTS_CHANNEL_ID] = 'import';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const threadReportMap = new Map();
const tickets = require('./tickets');
const personal = require('./personal');
const bugsCommand = require('./bugs-command');

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('syncreport')
      .setDescription('Add this thread to DevTrack if it was missed by automatic tracking')
      .toJSON(),
    ...creditCommandDefs(),
    ...assetCommandDefs(), // empty unless ASSETS_ENABLED=true
    ...bugsCommand.getCommandDefinitions(), // /bugs search: anonymous lookup of active bug reports
    ...personal.getCommandDefinitions(), // /ask /note /remind, owner only, usable anywhere; empty unless PERSONAL_OWNER_DISCORD_ID is set
    ...robloxConvert.getCommandDefinitions(), // right-click → Apps → Convert to Roblox (owner only)
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      // Everything except the owner's private commands stays a server command: with User Install on,
      // Discord would otherwise let anyone who adds the app run them outside the server.
      { body: commands.map(c => (c.integration_types ? c : { ...c, integration_types: [0], contexts: [0] })) }
    );
    console.log('[Commands] Slash commands registered');
  } catch (err) {
    console.error('[Commands] Failed to register slash commands:', err.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`DevTrack Bot online as ${c.user.tag}`);
  console.log(`Watching channels:`);
  Object.entries(WATCHED_CHANNELS).forEach(([id, type]) => {
    console.log(`  ${type.padEnd(12)} → ${id}`);
  });
  console.log(`  API          → ${process.env.API_URL}`);
  qaCheck.setClient(client);
  webhookServer.start();
  await registerCommands();
  await reportPause.syncPauseState();
  personal.start(client); // no-op unless PERSONAL_OWNER_DISCORD_ID is set
  tickets.start(client, threadReportMap); // Ticket Tool tickets as bug reports; off with TICKETS_ENABLED=false
  assetAgent.start(client); // no-op unless ASSET_AGENT_ENABLED=true
  assetStatus.start(client, assetAgent.allowedIds); // no-op unless ASSET_STATUS_POSTS=true

  escalateStaleCreditRequests(client).catch(err => console.error('[CreditEscalation] Initial poll failed:', err.message));
  setInterval(() => {
    escalateStaleCreditRequests(client).catch(err => console.error('[CreditEscalation] Poll failed:', err.message));
  }, CREDIT_ESCALATION_POLL_MS);
});

// Handle slash commands and button interactions
client.on(Events.InteractionCreate, async (interaction) => {
 try {
  if (interaction.isStringSelectMenu()) {
    if (await assetPayouts.handleSelect(interaction)) return;
    return;
  }

  // Handle retry buttons from failed report submissions
  if (interaction.isButton()) {
    if (interaction.customId?.startsWith('retry_report:')) {
      const { handleNewPost } = require('./handler');
      const retryDeps = { handleNewPost, client, WATCHED_CHANNELS, threadReportMap };
      await handleRetryButton(interaction, retryDeps);
      return;
    }
    if (await handleCreditButton(interaction)) return;
    if (await assetAgent.handleButton(interaction)) return;
    if (await qaCheck.handleButton(interaction)) return;
    if (await assetPayouts.handleButton(interaction)) return;
    return;
  }

  if (interaction.isModalSubmit()) {
    if (await qaCheck.handleModal(interaction)) return;
    if (await assetPayouts.handleModal(interaction)) return;
    if (await robloxConvert.handleModal(interaction)) return;
  }

  if (await robloxConvert.handleContextMenu(interaction)) return;

  if (!interaction.isChatInputCommand()) return;

  if (await personal.handleCommand(interaction)) return;
  if (await bugsCommand.handleBugs(interaction)) return;


  if (interaction.commandName === 'syncreport') {
    await handleSyncReport(interaction, WATCHED_CHANNELS, threadReportMap);
    return;
  }

  if (interaction.commandName === 'credit') {
    await handleCredit(interaction, WATCHED_CHANNELS);
    return;
  }

  if (interaction.commandName === 'assets') {
    await handleAssets(interaction);
    return;
  }

  if (interaction.commandName === 'requestcredit') {
    await handleRequestCredit(interaction, WATCHED_CHANNELS);
    return;
  }

 } catch (err) {
  // Never let a single bad interaction (e.g. an expired/already-acknowledged
  // token — DiscordAPIError 10062) crash the whole bot process.
  console.error('[InteractionCreate] Unhandled error:', err.message);
  const reply = { content: '❌ Something went wrong handling that. Please try again.', ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply);
    else await interaction.reply(reply);
  } catch (replyErr) {
    console.error('[InteractionCreate] Could not notify user of the error:', replyErr.message);
  }
 }
});

// New forum post created
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated) return;
  const parentId = thread.parentId;
  const reportType = WATCHED_CHANNELS[parentId];
  if (!reportType) return;
  if (reportType === 'import') return;

  if (reportType === 'bug' && reportPause.isPaused()) {
    console.log(`[ThreadCreate] Reports paused — not logging "${thread.name}"`);
    let starter = null;
    try {
      await new Promise((r) => setTimeout(r, 1500));
      starter = await thread.fetchStarterMessage({ cache: false });
    } catch { /* best-effort — notice/attempt still work without author info */ }

    await reportPause.postPausedNotice(thread, starter?.author?.id);
    await reportPause.registerPausedAttempt({
      threadId: thread.id,
      channelId: parentId,
      discordUserId: starter?.author?.id || '',
      discordUser: starter?.author?.tag || 'unknown',
      title: thread.name,
    });
    return;
  }

  console.log(`[ThreadCreate] New ${reportType} post: "${thread.name}" in channel ${parentId}`);

  // Wait for Discord to settle before fetching
  await new Promise((r) => setTimeout(r, 4000));

  // Try fetchStarterMessage with increasing backoff: 2s, 4s, 6s, 8s, 10s
  let starterMessage = null;
  const delays = [2000, 4000, 6000, 8000, 10000];
  for (let i = 0; i < delays.length; i++) {
    try {
      starterMessage = await thread.fetchStarterMessage({ cache: false });
      if (starterMessage) break;
    } catch {
      console.log(`[ThreadCreate] Starter message not ready, retrying (${i + 1}/${delays.length}) in ${delays[i]/1000}s…`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }

  // Fallback: grab the first message from thread history
  if (!starterMessage) {
    console.log(`[ThreadCreate] fetchStarterMessage failed — trying message history fallback for "${thread.name}"`);
    try {
      const messages = await thread.messages.fetch({ limit: 5 });
      // Starter message is the oldest one
      starterMessage = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();
    } catch (err) {
      console.error(`[ThreadCreate] History fallback also failed for "${thread.name}":`, err.message);
    }
  }

  if (!starterMessage) {
    console.error(`[ThreadCreate] Could not fetch starter message for "${thread.name}" after all retries — skipping.`);
    return;
  }

  console.log(`[ThreadCreate] Got starter message for "${thread.name}" (id: ${starterMessage.id})`);

  try {
    const reportId = await handleNewPost({ thread, starterMessage, reportType, client });
    if (reportId) {
      threadReportMap.set(thread.id, reportId);
      console.log(`[ThreadCreate] Cached thread ${thread.id} → report ${reportId}`);

      // Seed ⭐ reaction on suggestion starter message so users can upvote
      if (reportType === 'suggestion' && starterMessage) {
        await starterMessage.react('⭐').catch(() => {});
        console.log(`[ThreadCreate] Seeded ⭐ reaction on suggestion`);
      }
    }
  } catch (err) {
    console.error(`[ThreadCreate] Failed to handle post "${thread.name}":`, err);
  }
});

// New message in tracked thread
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    // Ticket Tool posting a transcript is the one bot message that matters.
    tickets.onBotMessage(message).catch(err => console.error('[Tickets] onBotMessage failed:', err.message));
    return;
  }
  // A DM to the bot: answered for the owner, ignored for everyone else, and never treated as a report.
  try { if (await personal.onMessage(message)) return; } catch (err) { console.error('[Personal] onMessage failed:', err.message); return; }
  // Asset agent ingest: only allowlisted channels, and it never throws.
  try { assetAgent.onMessage(message); } catch (err) { console.error('[AssetAgent] onMessage failed:', err.message); }
  if (process.env.IMPORTS_CHANNEL_ID && message.channelId === process.env.IMPORTS_CHANNEL_ID) {
    if (!message.attachments?.size) return;
    try {
      const importId = await handleImportMessage(message);
      if (importId) {
        console.log(`[Imports] Queued import ${importId} from message ${message.id}`);
        await message.react('➖').catch(() => {});
      }
    } catch (err) {
      if (err.response?.status === 409) return;
      console.error('[Imports] Failed to queue import:', err.response?.data || err.message);
      await message.react('⚠️').catch(() => {});
    }
    return;
  }

  // Ticket Tool tickets are text channels, not threads; they log themselves.
  try { if (await tickets.onMessage(message)) return; } catch (err) { console.error('[Tickets] onMessage failed:', err.message); }

  if (!message.channel?.isThread()) return;

  const thread = message.channel;
  const parentId = thread.parentId;
  if (!WATCHED_CHANNELS[parentId]) return;
  if (WATCHED_CHANNELS[parentId] === 'import') return;

  const threadId = thread.id;
  const reportId = threadReportMap.get(threadId);
  if (!reportId) {
    console.log(`[MessageCreate] Thread ${threadId} not in cache — skipping`);
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


client.on(Events.ChannelCreate, (channel) => {
  try { tickets.onChannelCreate(channel); } catch (err) { console.error('[Tickets] onChannelCreate failed:', err.message); }
});

client.on(Events.ChannelDelete, (channel) => {
  tickets.onChannelDelete(channel).catch(err => console.error('[Tickets] onChannelDelete failed:', err.message));
});

// Sync ⭐ reaction counts on suggestion posts
async function syncStarCount(reaction, isSuggestion) {
  if (reaction.emoji.name !== '⭐') return;
  const message = reaction.message.partial ? await reaction.message.fetch() : await reaction.message.channel.messages.fetch(reaction.message.id).catch(() => reaction.message);
  const thread = message.channel;
  if (!thread?.isThread()) return;
  if (!WATCHED_CHANNELS[thread.parentId]) return;
  if (WATCHED_CHANNELS[thread.parentId] !== 'suggestion') return;

  // Only count stars on the starter message
  const starter = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
  if (!starter || starter.id !== message.id) return;

  const starReaction = message.reactions.cache.get('⭐');
  // Subtract 1 for the bot's own seed reaction
  const count = Math.max(0, (starReaction?.count || 0) - 1);

  const reportId = threadReportMap.get(thread.id);
  if (!reportId) return;

  try {
    await axios.patch(`${API_URL}/api/reports/${reportId}/upvotes`, { upvotes: count }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Stars] Synced ${count} stars for report ${reportId}`);
  } catch (err) {
    console.error(`[Stars] Failed to sync stars:`, err.message);
  }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  await syncStarCount(reaction, true);
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  await syncStarCount(reaction, true);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Failed to login to Discord:', err.message);
  process.exit(1);
});
