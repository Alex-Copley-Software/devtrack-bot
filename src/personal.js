// personal.js
// The owner's private side of the bot. One Discord account
// (PERSONAL_OWNER_DISCORD_ID) can:
//
//   DM the bot             talk to the assistant with no prefix
//   /ask /note /remind     from anywhere: any server, anyone's DM, group chats
//                          (the app is installed to their account, "User Install")
//
// and gets reminders as a DM from the bot when they fall due. Nobody else can
// use any of it. The backend checks the account again on every call.

const axios = require('axios');
const { ChannelType, MessageFlags } = require('discord.js');
const assetAgent = require('./asset-agent');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || '').trim();
const api = (path, data, timeout = 15000) => axios({
  method: 'post', url: `${API_URL}/api/bot/assets${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout,
}).then(r => r.data);

const isOwner = id => !!OWNER && String(id) === OWNER;

// The last few exchanges, so a follow-up ("and the texture?", "make that 4pm") makes sense. Kept in memory only.
const HISTORY_MS = 30 * 60 * 1000;
let history = [];
function remember(role, content) {
  if (!content) return;
  history.push({ role, name: 'Owner', content: String(content).slice(0, 1500), at: Date.now() });
  history = history.filter(h => Date.now() - h.at < HISTORY_MS).slice(-10);
}
const recent = () => history.filter(h => Date.now() - h.at < HISTORY_MS).map(({ role, name, content }) => ({ role, name, content }));

// ── commands ──────────────────────────────────────────────────────────────────

// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };
const text = (name, description, required = true, max = 1500) => ({ type: 3, name, description, required, max_length: max });

function getCommandDefinitions() {
  if (!OWNER) return [];
  return [
    { name: 'ask', description: 'Private: ask your assistant (notes, reminders, assets, payments)', ...ANYWHERE,
      options: [text('question', 'What you want to know or do'), { type: 5, name: 'share', description: 'Show the answer to everyone here (default: only you)', required: false }] },
    { name: 'note', description: 'Private: save a note only you can read back', ...ANYWHERE, options: [text('text', 'The note', true, 3500)] },
    { name: 'remind', description: 'Private: set a reminder, sent to you as a DM', ...ANYWHERE,
      options: [text('what', 'What to be reminded of', true, 800), text('when', 'When, e.g. "friday 3pm", "in 2 hours", "every monday 9am"', true, 200)] },
  ];
}
const COMMANDS = new Set(['ask', 'note', 'remind']);

const errorText = err => (err.response?.status === 403 ? 'This is private.' : err.response?.data?.error || 'I could not do that just now. Try again in a minute.');

// Asks the assistant in private mode. source: where it was said, for the record on any card it makes.
async function askAssistant(content, { id, channelId, guildId, authorName, attachments = [] }) {
  const result = await api('/assistant', {
    private: true,
    message: { id, channelId, guildId: guildId || null, channelName: 'private', authorDiscordId: OWNER, authorName, content, attachments, postedAt: new Date().toISOString() },
    history: recent(),
  }, 150000);
  remember('user', content);
  remember('assistant', result.reply);
  return result;
}

const cards = result => (result.proposals || []).map(s => ({ embeds: [assetAgent.suggestionEmbed(s)], components: [assetAgent.suggestionButtons(s)], allowedMentions: { parse: [] } }));

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || !COMMANDS.has(interaction.commandName)) return false;
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'This command is private.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const name = interaction.commandName;
  const share = name === 'ask' && interaction.options.getBoolean('share') === true;
  const flags = share ? undefined : MessageFlags.Ephemeral;
  await interaction.deferReply({ flags });
  try {
    if (name === 'note') {
      const saved = await api('/personal/note', { discordUserId: interaction.user.id, text: interaction.options.getString('text', true) });
      await interaction.editReply(`Noted (#${saved.ref}).`);
      return true;
    }
    const content = name === 'remind'
      ? `Set a reminder. What: ${interaction.options.getString('what', true)}. When: ${interaction.options.getString('when', true)}.`
      : interaction.options.getString('question', true);
    const result = await askAssistant(content, {
      id: interaction.id, channelId: interaction.channelId, guildId: interaction.guildId,
      authorName: interaction.user.globalName || interaction.user.username,
    });
    await interaction.editReply({ content: result.reply || 'Done.', allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
    // Anything that changes the tracker or logs money still waits on a card. Only the owner can press it.
    for (const card of cards(result)) await interaction.followUp({ ...card, flags });
  } catch (err) {
    console.error(`[Personal] /${name} failed:`, err.response?.data?.error || err.message);
    await interaction.editReply(errorText(err)).catch(() => {});
  }
  return true;
}

// ── DMs ───────────────────────────────────────────────────────────────────────

// A direct message to the bot. Returns true when it was one (handled or ignored), so nothing else looks at it.
async function onMessage(message) {
  if (message.channel?.type !== ChannelType.DM) return false;
  if (!isOwner(message.author.id)) return true;            // nobody else gets an answer in DMs
  const content = String(message.content || '').trim();
  if (!content && !message.attachments.size) return true;
  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  try {
    const result = await askAssistant(content, {
      id: message.id, channelId: message.channelId, guildId: null,
      authorName: message.author.globalName || message.author.username,
      attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null })),
    });
    if (result.reply) await message.reply({ content: result.reply, allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
    for (const card of cards(result)) await message.channel.send(card);
  } catch (err) {
    console.error('[Personal] DM failed:', err.response?.data?.error || err.message);
    await message.reply({ content: errorText(err), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  } finally {
    clearInterval(typing);
  }
  return true;
}

// ── reminders ─────────────────────────────────────────────────────────────────

async function deliverReminders(client) {
  try {
    const { reminders } = await api('/personal/reminders/claim', {});
    if (!reminders?.length) return;
    const user = await client.users.fetch(OWNER);
    for (const r of reminders) {
      await user.send({
        content: `⏰ **Reminder:** ${r.text}${r.next ? `\n-# Repeats ${r.repeat}. Next: ${r.next} ET. Reminder #${r.ref}.` : ''}`,
        allowedMentions: { parse: [] },
      }).catch(err => console.error(`[Personal] Could not DM reminder #${r.ref}:`, err.message));
    }
  } catch (err) {
    if (err.response?.status !== 404) console.error('[Personal] Reminder check failed:', err.response?.data?.error || err.message);
  }
}

function start(client) {
  if (!OWNER) return;
  console.log('[Personal] Private commands, DMs and reminders are on for the owner account');
  setInterval(() => deliverReminders(client), 60000);
  deliverReminders(client);
}

module.exports = { start, getCommandDefinitions, handleCommand, onMessage, isOwner };
