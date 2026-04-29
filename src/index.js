require('dotenv').config();
const axios = require('axios');
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { handleNewPost } = require('./handler');
const { logMessage, getAttachments } = require('./message-logger');
const webhookServer = require('./webhook-server');
const { runSync } = require('./sync');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
  ],
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

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const threadReportMap = new Map();

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('sync')
      .setDescription('Scan forum channels and add any missing posts to the DevTrack queue')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('syncstars')
      .setDescription('Sync star reaction counts from all suggestion posts')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Post the top bug reporter leaderboard image to this channel')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
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
  webhookServer.start();
  await registerCommands();
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;


  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply();
    try {
      // Fetch all reports from backend
      const res = await axios.get(`${API_URL}/api/bot/reports`, {
        headers: { 'x-bot-secret': BOT_SECRET },
        timeout: 15000,
      });
      const reports = res.data || [];

      // Tally bug reporters
      function tally(arr) {
        const map = {};
        arr.forEach(r => {
          // Use discordUserId if available, fallback to discordUser string
          const key = r.discordUserId || r.discordUser || 'unknown';
          const name = r.discordUser || 'Unknown';
          if (!map[key]) map[key] = { name, count: 0, minor: 0, moderate: 0, major: 0 };
          map[key].count++;
          if (r.bugLevel) map[key][r.bugLevel] = (map[key][r.bugLevel] || 0) + 1;
        });
        // Return ALL reporters sorted, no slice
        return Object.values(map).sort((a, b) => b.count - a.count);
      }

      const accepted = reports.filter(r => !r.queued && (r.type === 'bug' || r.type === 'crash'));
      const suggestions = reports.filter(r => !r.queued && r.type === 'suggestion');
      const bugReporters = tally(accepted);
      const suggReporters = tally(suggestions);

      if (!bugReporters.length) {
        return interaction.editReply('No accepted bug reports yet!');
      }

      const guild = interaction.guild;
      // Build leaderboard as a text embed instead
      const medals = ['🥇','🥈','🥉'];
      // 10 squares per person, ceil to fill exactly 10
      function makeBar(r) {
        const total = r.count || 1;
        const SQUARES = 10;
        let minorSq = Math.round((r.minor || 0) / total * SQUARES);
        let modSq   = Math.round((r.moderate || 0) / total * SQUARES);
        let majSq   = Math.round((r.major || 0) / total * SQUARES);
        // Adjust to always equal exactly 10
        let sum = minorSq + modSq + majSq;
        if (sum < SQUARES) minorSq += (SQUARES - sum);
        if (sum > SQUARES) {
          const excess = sum - SQUARES;
          if (minorSq >= excess) minorSq -= excess;
          else if (modSq >= excess) modSq -= excess;
          else majSq -= excess;
        }
        return '🟦'.repeat(minorSq) + '🟧'.repeat(modSq) + '🟥'.repeat(majSq);
      }

      // Paginate — 10 per page
      const PAGE_SIZE = 10;
      const totalPages = Math.ceil(bugReporters.length / PAGE_SIZE);


      const suggLines = suggReporters.slice(0, 5).map((s, i) =>
        (medals[i] || ('#' + (i + 1))) + ' **' + s.name + '** — ' + s.count
      ).join('\n');

            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      function buildEmbed(pageNum) {
        const pageR = bugReporters.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);
        const pageLines = pageR.map((r, i) => {
          const rank = pageNum * PAGE_SIZE + i;
          const medal = medals[rank] || ('**#' + (rank+1) + '**');
          const parts = [r.minor && (r.minor + 'm'), r.moderate && (r.moderate + 'mod'), r.major && (r.major + 'maj')].filter(Boolean).join(' ');
          const partStr = parts ? ' *(' + parts + ')*' : '';
          return medal + ' **' + r.name + '** — ' + r.count + ' reports' + partStr + '\n' + makeBar(r);
        }).join('\n');

        return {
          title: '🏆 Bug Reporter Leaderboard — ' + accepted.length + ' total accepted',
          description: pageLines,
          color: 0x7c6cf0,
          fields: pageNum === 0 && suggReporters.length ? [{
            name: '💡 Top Suggestion Contributors',
            value: suggLines,
            inline: false
          }] : [],
          footer: { text: (guild?.name || 'DevTrack') + ' · Page ' + (pageNum+1) + '/' + totalPages + ' · ' + bugReporters.length + ' unique reporters' },
          timestamp: new Date().toISOString(),
        };
      }

      function buildRow(pageNum) {
        if (totalPages <= 1) return null;
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('lb_prev_' + pageNum).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(pageNum === 0),
          new ButtonBuilder().setCustomId('lb_next_' + pageNum).setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(pageNum >= totalPages - 1),
        );
      }

      const firstRow = buildRow(0);
      const msg = await interaction.editReply({
        embeds: [buildEmbed(0)],
        components: firstRow ? [firstRow] : [],
      });

      if (totalPages > 1) {
        // Collect button interactions for 5 minutes
        const collector = msg.createMessageComponentCollector({ time: 5 * 60 * 1000 });
        collector.on('collect', async btn => {
          await btn.deferUpdate();
          const parts2 = btn.customId.split('_');
          const dir = parts2[1]; // prev or next
          const curPage = parseInt(parts2[2]);
          const newPage = dir === 'next' ? curPage + 1 : curPage - 1;
          const clampedPage = Math.max(0, Math.min(newPage, totalPages - 1));
          const row = buildRow(clampedPage);
          await btn.editReply({ embeds: [buildEmbed(clampedPage)], components: row ? [row] : [] });
        });
        collector.on('end', async () => {
          await msg.edit({ components: [] }).catch(() => {});
        });
      }
    } catch (err) {
      console.error('[Leaderboard]', err.message);
      await interaction.editReply('❌ Failed to generate leaderboard — check the bot logs.');
    }
  }

  if (interaction.commandName === 'syncstars') {
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need the Manage Server permission to run this.', flags: 64 });
    }
    await interaction.reply({ content: '⭐ Scanning suggestion threads for star counts...', flags: 64 });
    try {
      const updates = [];
      for (const [channelId, type] of Object.entries(WATCHED_CHANNELS)) {
        if (type !== 'suggestion') continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        console.log(`[SyncStars] Scanning ${channel.name}`);
        const active = await channel.threads.fetchActive();
        const archived = await channel.threads.fetchArchived({ limit: 100 });
        const threads = [...active.threads.values(), ...archived.threads.values()];
        console.log(`[SyncStars] Found ${threads.length} threads`);

        for (const thread of threads) {
          try {
            // Look up reportId first
            let reportId = threadReportMap.get(thread.id);
            if (!reportId) {
              const res = await axios.get(`${API_URL}/api/bot/report-by-thread/${thread.id}`, {
                headers: { 'x-bot-secret': BOT_SECRET }, timeout: 5000
              }).catch(() => null);
              if (res?.data?.reportId) {
                reportId = res.data.reportId;
                threadReportMap.set(thread.id, reportId);
              }
            }
            if (!reportId) continue;

            // Fetch the starter message directly via channel messages
            const starter = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
            if (!starter) continue;

            // Fetch the message directly to get fresh reaction data
            const freshMsg = await thread.messages.fetch(starter.id).catch(() => null);
            if (!freshMsg) continue;

            // Seed ⭐ if not already there
            const starReaction = freshMsg.reactions.cache.get('⭐');
            if (!starReaction || starReaction.count === 0) {
              await starter.react('⭐').catch(() => {});
              console.log(`[SyncStars] Seeded ⭐ on "${thread.name}"`);
            }

            // Count minus bot's seed
            const freshCount = starReaction?.count || 0;
            const count = Math.max(0, freshCount - 1);

            console.log(`[SyncStars] Thread "${thread.name}": ${count} user stars`);
            updates.push({ reportId, upvotes: count });
          } catch (err) {
            console.error(`[SyncStars] Error on thread ${thread.id}:`, err.message);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      if (updates.length) {
        await axios.post(`${API_URL}/api/reports/sync-stars`, { updates }, {
          headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
          timeout: 15000,
        });
      }
      console.log(`[SyncStars] Done — ${updates.length} posts synced`);
      await interaction.editReply(`⭐ Synced star counts for **${updates.length}** suggestion posts.`);
    } catch (err) {
      console.error('[SyncStars]', err);
      await interaction.editReply('❌ Star sync failed — check the bot logs.');
    }
  }

  if (interaction.commandName === 'sync') {
    // Only allow admins or users with Manage Guild permission
    if (!interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need the Manage Server permission to run this.', flags: 64 });
    }

    await interaction.reply({ content: '🔄 Scanning forum channels for existing posts... this may take a moment.', flags: 64 });

    try {
      const result = await runSync(client, WATCHED_CHANNELS, threadReportMap);
      await interaction.editReply(
        `✅ **Sync complete!**\n> Added to queue: **${result.totalAdded}**\n> Already existed: **${result.totalSkipped}**\n> Failed: **${result.totalFailed}**`
      );
    } catch (err) {
      console.error('[Sync] Error:', err);
      await interaction.editReply('❌ Sync failed — check the bot logs.');
    }
  }
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
  if (!message.channel?.isThread()) return;
  if (message.author.bot) return;

  const thread = message.channel;
  const parentId = thread.parentId;
  if (!WATCHED_CHANNELS[parentId]) return;

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