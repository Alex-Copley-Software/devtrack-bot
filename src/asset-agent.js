// asset-agent.js
// Discord side of the AI Asset Agent. The bot stays a thin adapter: it
// forwards messages from allowlisted channels to the API, asks the API to
// process them about once a minute, and posts the resulting suggestions to
// the review channel with Accept / Reject buttons. The model calls, the
// validation and all state live in the backend.
//
// Does nothing unless ASSET_AGENT_ENABLED=true.

const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');

const assetPayouts = require('./asset-payouts');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';
const REVIEW_CHANNEL_ID = process.env.ASSET_AGENT_REVIEW_CHANNEL_ID;
const ENABLED = String(process.env.ASSET_AGENT_ENABLED || '').toLowerCase() === 'true';

const CONFIG_REFRESH_MS = 2 * 60 * 1000;
const FLUSH_MS = 5 * 1000;
const TICK_MS = 60 * 1000;

const headers = { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET };
const api = (method, path, data, timeout = 15000) => axios({ method, url: `${API_URL}/api/bot/assets${path}`, data, headers, timeout }).then(r => r.data);

let allowed = new Set();
assetPayouts.setScope(id => allowed.has(id));
let selfTestSeen; // undefined until the first config load, so an old request is not replayed on restart
let discordClient = null;
// The assistant: who it answers, and the channels where it answers without being mentioned.
let assistant = { enabled: false, admins: new Set(), channels: new Set() };
let buffer = [];
let ticking = false;

// ── ingest ────────────────────────────────────────────────────────────────────

async function refreshConfig() {
  try {
    const config = await api('get', '/agent/config');
    allowed = new Set(config.enabled ? config.channelIds : []);
    assistant = {
      enabled: !!(config.enabled && config.assistant?.enabled),
      admins: new Set((config.assistant?.admins || []).map(a => a.id)),
      channels: new Set((config.assistant?.channels || []).map(c => c.id)),
    };
    assetPayouts.configure(config.enabled ? config.payouts : null);
    checkAssistantChannels().catch(() => {});
    const token = config.selfTestToken || null;
    if (selfTestSeen !== undefined && token && token !== selfTestSeen && discordClient) {
      selfTest(discordClient).catch(err => console.error('[AssetAgent] Self-test failed:', err.message));
    }
    selfTestSeen = token;
  } catch (err) {
    // Keep the last known allowlist; a 404 just means the backend flag is off.
    if (err.response?.status !== 404) console.error('[AssetAgent] Could not refresh the channel allowlist:', err.message);
    else { allowed = new Set(); assistant = { enabled: false, admins: new Set(), channels: new Set() }; }
  }
}

// Called for every message the bot sees. Only messages in an allowlisted
// channel, a thread or forum post under one, or anything under an
// allowlisted category are kept, and only the fields the agent needs.
function onMessage(message) {
  if (!ENABLED || message.author?.bot || !message.guildId) return;
  if (!allowed.size && !assistant.channels.size) return;
  const channel = message.channel;
  const isThread = !!channel?.isThread?.();
  const parentId = isThread ? channel.parentId : null;
  const categoryId = (isThread ? channel.parent?.parentId : channel?.parentId) || null;
  // The review channel is never read, even when its category is allowlisted.
  if (REVIEW_CHANNEL_ID && (message.channelId === REVIEW_CHANNEL_ID || parentId === REVIEW_CHANNEL_ID)) return;
  const inScope = [message.channelId, parentId, categoryId].some(id => id && allowed.has(id));
  const inAssistantChannel = [message.channelId, parentId].some(id => id && assistant.channels.has(id));
  if (!inScope && !inAssistantChannel) return;
  const payload = {
    id: message.id,
    channelId: message.channelId,
    parentChannelId: parentId,
    categoryId,
    // The post or channel name often says what the files are ("Starrk face").
    channelName: isThread && channel.parent?.name ? `${channel.parent.name} / ${channel.name}` : channel?.name || null,
    guildId: message.guildId,
    authorDiscordId: message.author.id,
    authorName: message.member?.displayName || message.author.username,
    content: message.content || '',
    attachments: [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url })),
    postedAt: new Date(message.createdTimestamp).toISOString(),
  };

  // A dev's Payments post is for payout requests only: it is not chatter for
  // the suggestion pipeline, and the assistant does not answer there.
  if (inScope && assetPayouts.isPaymentsPost(channel)) {
    assetPayouts.handleMessage(message, payload).catch(err => console.error('[AssetPayouts] failed:', err.message));
    return;
  }

  // An approved person talking to the bot: always in an assistant channel,
  // elsewhere only when they mention it or reply to it.
  const me = message.client?.user?.id;
  const addressed = !!me && message.mentions?.users?.has(me);
  if (assistant.enabled && assistant.admins.has(message.author.id) && (inAssistantChannel || addressed)) {
    answer(message, payload).catch(err => console.error('[AssetAssistant] failed:', err.message));
  }
  // Assistant channels are a conversation with the bot, not dev chatter for the suggestion pipeline.
  if (inScope && !inAssistantChannel) buffer.push(payload);
}

// ── assistant ─────────────────────────────────────────────────────────────────

// The usual reason the assistant stays silent: the bot is not allowed into the
// channel (admin forums are often private), so Discord never sends it the
// message. Say so in the log, once per channel and state.
const channelState = new Map();
async function checkAssistantChannels() {
  if (!discordClient || !assistant.enabled) return;
  for (const id of assistant.channels) {
    const channel = await discordClient.channels.fetch(id).catch(() => null);
    const perms = channel?.permissionsFor?.(discordClient.user);
    const missing = !channel ? 'cannot see it at all (add the bot or its role to that channel or forum)'
      : ['ViewChannel', 'ReadMessageHistory', channel.isThread?.() ? 'SendMessagesInThreads' : 'SendMessages'].filter(p => !perms?.has(p)).join(', ');
    const state = missing || 'ok';
    if (channelState.get(id) === state) continue;
    channelState.set(id, state);
    if (missing) console.error(`[AssetAssistant] Assistant channel ${id}${channel?.name ? ` "${channel.name}"` : ''}: the bot ${channel ? `is missing ${missing}` : missing}`);
    else console.log(`[AssetAssistant] Assistant channel ${id} "${channel.name}" is reachable. Answering ${assistant.admins.size} approved account(s).`);
  }
}

const stripMention = (text, me) => String(text || '').replace(new RegExp(`<@!?${me}>`, 'g'), '').trim();

async function answer(message, payload) {
  const me = message.client.user.id;
  const content = stripMention(payload.content, me);
  if (!content && !payload.attachments.length) return;
  console.log(`[AssetAssistant] ${payload.authorName} in ${payload.channelName || payload.channelId}: answering`);
  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  try {
    // The last few turns between approved people and the bot, so follow-ups ("and the texture?") make sense.
    const recent = await message.channel.messages.fetch({ limit: 12, before: message.id }).catch(() => null);
    const history = recent ? [...recent.values()]
      .filter(m => m.author.id === me || assistant.admins.has(m.author.id))
      .filter(m => Date.now() - m.createdTimestamp < 6 * 60 * 60 * 1000)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => ({ role: m.author.id === me ? 'assistant' : 'user', name: m.member?.displayName || m.author.username, content: stripMention(m.content, me) }))
      .filter(h => h.content) : [];
    const result = await api('post', '/assistant', { message: { ...payload, content }, history }, 150000);
    if (result.reply) {
      await message.reply({ content: result.reply, allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404) return; // access was removed, or the agent is switched off
    console.error('[AssetAssistant] Could not answer:', err.response?.data?.error || err.message);
    await message.reply({ content: 'I could not answer that just now. Try again in a minute.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

async function flush() {
  if (!buffer.length) return;
  const messages = buffer;
  buffer = [];
  try {
    await api('post', '/messages', { messages });
  } catch (err) {
    console.error(`[AssetAgent] Could not store ${messages.length} message(s):`, err.response?.data?.error || err.message);
    // Put them back for the next flush unless the backlog is getting silly.
    if (buffer.length < 500) buffer = messages.concat(buffer);
  }
}

// ── review channel ────────────────────────────────────────────────────────────

const TYPE_TITLES = {
  update_task_status: 'Status change',
  assign_task: 'Assignment',
  set_due_date: 'Due date',
  add_task_note: 'Note',
  mark_blocked: 'Blocked',
  create_content_item: 'New content item',
  flag_unknown: 'Needs a look',
};

const show = value => (value === null || value === undefined || value === '' ? 'none' : String(value));
function diffLines(suggestion) {
  const before = suggestion.before || {};
  const after = suggestion.after || {};
  const keys = Object.keys(after);
  if (!keys.length) return null;
  return keys.map(k => (k in before ? `**${k}:** ${show(before[k])} → ${show(after[k])}` : `**${k}:** ${show(after[k])}`)).join('\n').slice(0, 1000);
}

function suggestionEmbed(suggestion, footerNote) {
  const pending = suggestion.status === 'pending';
  const color = pending ? 0x7c6cf0 : suggestion.status === 'rejected' ? 0xf87171 : 0x34d399;
  const embed = new EmbedBuilder()
    .setTitle(`${TYPE_TITLES[suggestion.type] || suggestion.type}`)
    .setDescription(String(suggestion.summary || '').slice(0, 2000) || 'No summary')
    .setColor(color)
    .setTimestamp(new Date(suggestion.createdAt || Date.now()));
  const diff = diffLines(suggestion);
  if (diff) embed.addFields({ name: 'Change', value: diff });
  if (suggestion.reason) embed.addFields({ name: 'Why', value: String(suggestion.reason).slice(0, 1000) });
  embed.addFields({ name: 'Confidence', value: `${Math.round((suggestion.confidence || 0) * 100)}%`, inline: true });
  const evidence = (suggestion.evidence || []).filter(e => e.url).slice(0, 5);
  if (evidence.length) {
    embed.addFields({ name: 'From', value: evidence.map(e => `[${e.authorName || 'message'}](${e.url})`).join(' · ').slice(0, 1000), inline: true });
  }
  // A flag proposes no change, so its buttons say what they do: note it, or wave it off.
  const flag = suggestion.type === 'flag_unknown';
  const state = footerNote
    || (pending ? 'Waiting for a lead or manager'
      : `${flag ? (suggestion.status === 'rejected' ? 'Dismissed' : 'Acknowledged') : suggestion.status === 'rejected' ? 'Rejected' : 'Accepted'}${suggestion.resolvedVia === 'auto' ? ' automatically' : suggestion.resolvedByName ? ` by ${suggestion.resolvedByName}` : ''}`);
  embed.setFooter({ text: state });
  return embed;
}

function suggestionButtons({ id, type }) {
  const flag = type === 'flag_unknown';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`asset_sug:accept:${id}`).setLabel(flag ? 'Acknowledge' : 'Accept').setStyle(flag ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`asset_sug:reject:${id}`).setLabel(flag ? 'Dismiss' : 'Reject').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Open inbox').setStyle(ButtonStyle.Link).setURL(`${DASHBOARD}/assets/#/suggestions`),
  );
}

async function postSuggestions(client, list) {
  if (!list.length) return;
  if (!REVIEW_CHANNEL_ID) { console.warn('[AssetAgent] ASSET_AGENT_REVIEW_CHANNEL_ID is not set; suggestions are only in the web inbox.'); return; }
  const channel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
  if (!channel) { console.error(`[AssetAgent] Review channel ${REVIEW_CHANNEL_ID} not found`); return; }
  for (const suggestion of list) {
    try {
      const sent = await channel.send({
        embeds: [suggestionEmbed(suggestion)],
        components: suggestion.status === 'pending' ? [suggestionButtons(suggestion)] : [],
        allowedMentions: { parse: [] },
      });
      await api('post', `/suggestions/${suggestion.id}/posted`, { channelId: channel.id, messageId: sent.id }).catch(() => {});
    } catch (err) {
      console.error(`[AssetAgent] Could not post suggestion ${suggestion.id}:`, err.message);
    }
  }
}

// Accept / Reject buttons. The API decides whether the clicker is a lead or
// manager; the bot only relays the answer.
async function handleButton(interaction) {
  if (!interaction.isButton() || !interaction.customId?.startsWith('asset_sug:')) return false;
  const [, decision, id] = interaction.customId.split(':');
  await interaction.deferUpdate();
  try {
    const suggestion = await api('post', `/suggestions/${id}/resolve`, {
      decision, discordUserId: interaction.user.id, discordUserName: interaction.user.username,
    });
    await interaction.editReply({ embeds: [suggestionEmbed(suggestion)], components: [] });
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error || 'Something went wrong. Try again, or use the web inbox.';
    if (status === 409 || status === 404) {
      // Already handled somewhere else (usually the web inbox): retire the buttons.
      const original = interaction.message.embeds[0];
      const embed = original ? EmbedBuilder.from(original).setFooter({ text: message }).setColor(0x606078) : null;
      await interaction.editReply({ embeds: embed ? [embed] : [], components: [] }).catch(() => {});
    }
    await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
  }
  return true;
}

// ── self-test ─────────────────────────────────────────────────────────────────

// Proves the two things that cannot be checked from the backend: that the bot
// can read the allowlisted channels, and that it can post in the review
// channel. It then shows what the agent would propose for the most recent
// conversation it read. Read-only: nothing is stored and the tracker is not touched.
async function readable(channel, limit) {
  const fetched = await channel.messages.fetch({ limit });
  return [...fetched.values()].filter(m => !m.author?.bot).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function selfTest(client) {
  const lines = [];
  const samples = []; // { name, messages }
  const probe = async channel => {
    if (!channel || channel.id === REVIEW_CHANNEL_ID || channel.parentId === REVIEW_CHANNEL_ID) return;
    const name = `#${channel.name}`;
    try {
      if (channel.threads && !channel.messages) {
        // Forum: its posts are threads.
        const active = await channel.threads.fetchActive();
        const posts = [...active.threads.values()].sort((a, b) => Number(BigInt(b.lastMessageId || 0) - BigInt(a.lastMessageId || 0))).slice(0, 3);
        let count = 0;
        for (const post of posts) {
          const messages = await readable(post, 15);
          count += messages.length;
          if (messages.length) samples.push({ name: `${name} / ${post.name}`, messages });
        }
        lines.push(`OK  ${name} (forum): ${active.threads.size} open post(s), read ${count} message(s) from the latest ${posts.length}`);
      } else if (channel.messages) {
        const messages = await readable(channel, 25);
        if (messages.length) samples.push({ name, messages });
        lines.push(`OK  ${name}: read ${messages.length} recent message(s)`);
      }
    } catch (err) {
      lines.push(`FAILED  ${name}: ${err.message}`);
    }
  };

  for (const id of allowed) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel) { lines.push(`FAILED  ${id}: the bot cannot see this channel or category`); continue; }
    if (channel.children) {
      const children = [...channel.children.cache.values()];
      lines.push(`Category "${channel.name}": ${children.length} channel(s)`);
      for (const child of children) await probe(child);
    } else {
      await probe(channel);
    }
  }
  if (!allowed.size) lines.push('No channels or categories are on the allowlist yet, so there was nothing to read. Add one under Assets, Agent settings.');

  // What the agent makes of the most recent conversation it could read.
  let agent = 'Skipped: no messages were read.';
  const latest = samples.sort((a, b) => b.messages.at(-1).createdTimestamp - a.messages.at(-1).createdTimestamp)[0];
  if (latest) {
    try {
      const result = await api('post', '/agent/dry-run', {
        messages: latest.messages.slice(-25).map(m => ({
          id: m.id, channelId: m.channelId, guildId: m.guildId, authorDiscordId: m.author.id,
          authorName: m.member?.displayName || m.author.username, content: m.content || '',
          postedAt: new Date(m.createdTimestamp).toISOString(),
        })),
      }, 4 * 60 * 1000);
      const head = `Read ${latest.messages.length} message(s) from ${latest.name} against a tracker of ${result.tracker?.tasks ?? 0} task(s).`;
      if (result.empty) agent = `${head} They had no text to analyse.`;
      else if (!result.relevant) agent = `${head} The filter judged them not about assets, so nothing would be proposed.`;
      else {
        agent = [head, `It would propose ${result.proposals.length} change(s)${result.dropped.length ? ` (${result.dropped.length} more discarded by validation)` : ''}:`,
          ...result.proposals.slice(0, 8).map(p => `- ${p.summary} (${Math.round(p.confidence * 100)}%)`)].join('\n');
      }
      agent += `\nModel cost: $${(result.costUsd || 0).toFixed(4)}`;
    } catch (err) {
      agent = `FAILED: ${err.response?.data?.error || err.message}`;
    }
  }

  console.log(`[AssetAgent] Self-test\n${lines.join('\n')}\n${agent}`);
  if (!REVIEW_CHANNEL_ID) { console.warn('[AssetAgent] Self-test: no review channel set, result is only in the log.'); return; }
  try {
    const review = await client.channels.fetch(REVIEW_CHANNEL_ID);
    await review.send({
      embeds: [new EmbedBuilder()
        .setTitle('Asset agent self-test')
        .setDescription('This is a test. Nothing was stored and nothing in the tracker was changed.')
        .setColor(lines.some(l => l.startsWith('FAILED')) ? 0xf87171 : 0x34d399)
        .addFields(
          { name: 'Reading', value: lines.join('\n').slice(0, 1024) || 'Nothing to read' },
          { name: 'What the agent made of it', value: agent.slice(0, 1024) },
          { name: 'Posting', value: 'OK  this message is the proof the bot can post here.' },
        )
        .setTimestamp(new Date())],
      allowedMentions: { parse: [] },
    });
    console.log('[AssetAgent] Self-test posted to the review channel');
  } catch (err) {
    console.error(`[AssetAgent] Self-test could not post to the review channel ${REVIEW_CHANNEL_ID}: ${err.message}`);
  }
}

// ── tick ──────────────────────────────────────────────────────────────────────

let lastState = null;
async function tick(client) {
  if (ticking) return; // the previous tick is still waiting on the model
  ticking = true;
  try {
    await flush();
    const result = await api('post', '/agent/tick', {}, 4 * 60 * 1000);
    if (result.state !== lastState) {
      if (result.state !== 'ok') console.log(`[AssetAgent] Agent is ${result.state.replace('_', ' ')}`);
      lastState = result.state;
    }
    for (const batch of result.processed || []) {
      console.log(`[AssetAgent] Batch ${batch.batchId} (${batch.messages} msgs): ${batch.error ? `failed: ${batch.error}` : batch.relevant ? `${batch.suggestions} suggestion(s)` : 'not about assets'}`);
    }
    await postSuggestions(client, result.toPost || []);
    // Payouts marked on the Assets page: tick the dev's message and tell them.
    for (const payout of result.payoutSync || []) await assetPayouts.applyUpdate(client, payout);
  } catch (err) {
    if (err.response?.status !== 404) console.error('[AssetAgent] Tick failed:', err.response?.data?.error || err.message);
  } finally {
    ticking = false;
  }
}

function start(client) {
  if (!ENABLED) return;
  console.log(`[AssetAgent] Enabled. Review channel: ${REVIEW_CHANNEL_ID || '(not set, web inbox only)'}`);
  discordClient = client;
  refreshConfig().then(() => {
    console.log(`[AssetAgent] Reading ${allowed.size} allowlisted channel(s)`);
    console.log(`[AssetAssistant] ${assistant.enabled ? `Answering ${assistant.admins.size} approved account(s), ${assistant.channels.size} assistant channel(s)` : 'Off'}`);
    // ASSET_AGENT_SELFTEST=true runs the self-test once on startup.
    if (String(process.env.ASSET_AGENT_SELFTEST || '').toLowerCase() === 'true') {
      selfTest(client).catch(err => console.error('[AssetAgent] Self-test failed:', err.message));
    }
  });
  setInterval(refreshConfig, CONFIG_REFRESH_MS);
  setInterval(() => flush().catch(() => {}), FLUSH_MS);
  setInterval(() => tick(client).catch(() => {}), TICK_MS);
}

module.exports = { start, onMessage, handleButton, suggestionEmbed, allowedIds: () => [...allowed] };
