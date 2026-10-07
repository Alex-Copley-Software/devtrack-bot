// asset-agent.js
// Discord side of the AI Asset Agent. The bot stays a thin adapter: it
// forwards messages from allowlisted channels to the API, asks the API to
// process them about once a minute, and posts the resulting suggestions to
// the review channel with Accept / Reject buttons. The model calls, the
// validation and all state live in the backend.
//
// Does nothing unless ASSET_AGENT_ENABLED=true.

const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

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
let buffer = [];
let ticking = false;

// ── ingest ────────────────────────────────────────────────────────────────────

async function refreshConfig() {
  try {
    const config = await api('get', '/agent/config');
    allowed = new Set(config.enabled ? config.channelIds : []);
  } catch (err) {
    // Keep the last known allowlist; a 404 just means the backend flag is off.
    if (err.response?.status !== 404) console.error('[AssetAgent] Could not refresh the channel allowlist:', err.message);
    else allowed = new Set();
  }
}

// Called for every message the bot sees. Only messages in an allowlisted
// channel, a thread or forum post under one, or anything under an
// allowlisted category are kept, and only the fields the agent needs.
function onMessage(message) {
  if (!ENABLED || !allowed.size || message.author?.bot || !message.guildId) return;
  const channel = message.channel;
  const isThread = !!channel?.isThread?.();
  const parentId = isThread ? channel.parentId : null;
  const categoryId = (isThread ? channel.parent?.parentId : channel?.parentId) || null;
  // The review channel is never read, even when its category is allowlisted.
  if (REVIEW_CHANNEL_ID && (message.channelId === REVIEW_CHANNEL_ID || parentId === REVIEW_CHANNEL_ID)) return;
  if (![message.channelId, parentId, categoryId].some(id => id && allowed.has(id))) return;
  buffer.push({
    id: message.id,
    channelId: message.channelId,
    parentChannelId: parentId,
    categoryId,
    guildId: message.guildId,
    authorDiscordId: message.author.id,
    authorName: message.member?.displayName || message.author.username,
    content: message.content || '',
    attachments: [...(message.attachments?.values?.() || [])].map(a => ({ name: a.name, url: a.url })),
    postedAt: new Date(message.createdTimestamp).toISOString(),
  });
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
  const state = footerNote
    || (pending ? 'Waiting for a lead or manager'
      : `${suggestion.status === 'rejected' ? 'Rejected' : 'Accepted'}${suggestion.resolvedVia === 'auto' ? ' automatically' : suggestion.resolvedByName ? ` by ${suggestion.resolvedByName}` : ''}`);
  embed.setFooter({ text: state });
  return embed;
}

function suggestionButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`asset_sug:accept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`asset_sug:reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Secondary),
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
        components: suggestion.status === 'pending' ? [suggestionButtons(suggestion.id)] : [],
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
  } catch (err) {
    if (err.response?.status !== 404) console.error('[AssetAgent] Tick failed:', err.response?.data?.error || err.message);
  } finally {
    ticking = false;
  }
}

function start(client) {
  if (!ENABLED) return;
  console.log(`[AssetAgent] Enabled. Review channel: ${REVIEW_CHANNEL_ID || '(not set, web inbox only)'}`);
  refreshConfig().then(() => console.log(`[AssetAgent] Reading ${allowed.size} allowlisted channel(s)`));
  setInterval(refreshConfig, CONFIG_REFRESH_MS);
  setInterval(() => flush().catch(() => {}), FLUSH_MS);
  setInterval(() => tick(client).catch(() => {}), TICK_MS);
}

module.exports = { start, onMessage, handleButton, suggestionEmbed };
