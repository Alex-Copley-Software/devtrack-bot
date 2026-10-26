// qa-check.js
// Tester QA: when a report goes to QA Review, the tester who filed it is
// pinged in the report's own thread and asked to confirm the fix. They post
// a video, then press Fixed or Not fixed; nobody else in the thread can. The
// backend decides who may answer and records every check; this file is the
// Discord side only.
//
// If the tester has not answered after the set wait (30 minutes; /qadelay
// changes it, 0 turns it off), the check is posted in QA Requests. From then
// on only whoever holds it there can answer, the reporter included: Take this
// check makes it one person's for 30 minutes, nobody else can take it in that
// time, and they answer it in the report's thread with their own video or photo.
//
//   backend -> POST /qa-check          ask (posts the message with buttons)
//   backend -> POST /qa-check-update   staff approved it first, or it left QA Review
//   tester  -> Fixed / Not fixed       forwarded to POST /api/bot/qa-check/:id/respond
//   anyone  -> Take this check         forwarded to POST /api/bot/qa-check/:id/take
//   admins  -> /qadelay [minutes]      shows or sets the wait, POST /api/bot/qa-escalation

const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const QA_REQUESTS_CHANNEL_ID = process.env.QA_REQUESTS_CHANNEL_ID;
const ESCALATION_POLL_MS = 2 * 60 * 1000;
const api = (method, path, data) => axios({
  method, url: `${API_URL}/api/bot${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout: 15000,
}).then(r => r.data);

let client = null;
const setClient = c => { client = c; };

const VIDEO_LINK = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|streamable\.com|medal\.tv|clips\.twitch\.tv|gyazo\.com|imgur\.com|drive\.google\.com|cdn\.discordapp\.com|media\.discordapp\.net)\/\S+/i;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const messageUrl = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const minutesText = n => (n % 60 === 0 && n >= 60 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} minute${n === 1 ? '' : 's'}`);

function buttons(checkId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qa_check:fixed:${checkId}`).setLabel('Fixed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`qa_check:notfixed:${checkId}`).setLabel('Not fixed').setStyle(ButtonStyle.Danger),
  );
}

function takeButtons(checkId, checkUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qa_take:${checkId}`).setLabel('Take this check').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setURL(checkUrl).setLabel('Open the report').setStyle(ButtonStyle.Link),
  );
}

// ── from the backend ──────────────────────────────────────────────────────────

async function postCheck({ checkId, threadId, discordUserId, title, requireVideo, escalateMinutes }) {
  if (!client) throw new Error('Bot is not ready yet');
  try {
    // A resend after a restart: skip it if the first try got through, or the check is over.
    const current = await api('get', `/qa-check/${checkId}`).then(r => r.check, () => null);
    if (current && (current.messageId || current.status !== 'pending')) return;
    const thread = await client.channels.fetch(threadId);
    // A ticket left over from Ticket Tool is private, so its check is never opened up to others.
    const opensUp = thread.isThread?.() && escalateMinutes > 0;
    const sent = await thread.send({
      content: [
        `<@${discordUserId}> 🧪 **A fix for your report is ready for you to check.**`,
        title ? `> ${String(title).slice(0, 200)}` : '',
        `> Test it in game${requireVideo ? ', post a video or photo here showing the result,' : ''} then press a button below.`,
        `> **Fixed** if the bug is gone. **Not fixed** if it still happens.${requireVideo ? ' Either answer needs the video or photo first.' : ''}`,
        opensUp
          ? `> Only <@${discordUserId}> can answer. If it is not checked within ${minutesText(escalateMinutes)}, it moves to QA Requests, and from then on whoever takes it there (<@${discordUserId}> too) can answer.`
          : `> Only <@${discordUserId}> can press these buttons.`,
      ].filter(Boolean).join('\n'),
      components: [buttons(checkId)],
      allowedMentions: { users: [discordUserId] },
    });
    await api('post', `/qa-check/${checkId}/posted`, { messageId: sent.id });
    console.log(`[QaCheck] Asked ${discordUserId} to check thread ${threadId}`);
  } catch (err) {
    // The post was deleted: nobody can answer there, so withdraw the check instead of leaving it pending forever.
    if (err.code === 10003) {
      await api('post', `/qa-check/${checkId}/unreachable`, {}).catch(() => {});
      return console.log(`[QaCheck] Thread ${threadId} is gone; withdrew check ${checkId}`);
    }
    console.error(`[QaCheck] Could not post the check in thread ${threadId}:`, err.response?.data?.error || err.message);
    throw err; // the backend keeps it in its outbox and sends it again
  }
}

// Deletes the QA Requests post once the check is over, whoever ended it, so the channel only
// holds checks still waiting. If it cannot be deleted, it is retired in place with the outcome.
async function closeEscalation({ escalationChannelId, escalationMessageId }, line) {
  if (!client || !escalationChannelId || !escalationMessageId) return;
  const channel = await client.channels.fetch(escalationChannelId).catch(() => null);
  const message = await channel?.messages.fetch(escalationMessageId).catch(() => null);
  if (!message) return;
  const deleted = await message.delete().then(() => true, () => false);
  if (!deleted) await message.edit({ content: `${message.content}\n\n${line}`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
}

// Staff got there first, or the report left QA Review: retire the buttons and say why.
async function updateCheck({ threadId, messageId, discordUserId, takenByDiscordUserId, escalationChannelId, escalationMessageId, state, actorName }) {
  if (!client) return;
  try {
    const thread = await client.channels.fetch(threadId);
    const line = state === 'staff_approved'
      ? `✅ **Approved by staff**${actorName ? ` (${actorName})` : ''}. No check needed.`
      : '↩️ **This check was withdrawn.** The report moved out of QA review.';
    if (messageId) {
      const message = await thread.messages.fetch(messageId).catch(() => null);
      if (message) await message.edit({ content: `${message.content}\n\n${line}`, components: [] });
    }
    await closeEscalation({ escalationChannelId, escalationMessageId }, line);
    const told = [discordUserId, takenByDiscordUserId].filter(Boolean);
    if (state === 'staff_approved' && told.length) {
      await thread.send({
        content: `${told.map(id => `<@${id}>`).join(' ')} ✅ Staff have approved this fix, so you do not need to check it. Thanks!`,
        allowedMentions: { users: told },
      });
    }
  } catch (err) {
    console.error(`[QaCheck] Could not update the check in thread ${threadId}:`, err.message);
  }
}

// ── QA Requests ───────────────────────────────────────────────────────────────

function qaRequestsChannel(guild) {
  const byId = QA_REQUESTS_CHANNEL_ID && guild.channels.cache.get(QA_REQUESTS_CHANNEL_ID);
  if (byId) return byId;
  return guild.channels.cache.find(c => c.isTextBased?.() && !c.isThread?.() && norm(c.name).includes('qarequests')) || null;
}

const missingChannelLogged = new Set();

// Checks the tester has left unanswered are posted in QA Requests, once each.
async function escalate(check, minutes) {
  const thread = await client.channels.fetch(check.threadId).catch(() => null);
  if (!thread?.isThread?.()) return;
  const target = qaRequestsChannel(thread.guild);
  if (!target) {
    if (!missingChannelLogged.has(thread.guild.id)) console.error(`[QaCheck] No QA Requests channel in ${thread.guild.name}; set QA_REQUESTS_CHANNEL_ID or make a channel called qa-requests`);
    missingChannelLogged.add(thread.guild.id);
    return;
  }
  const checkUrl = messageUrl(thread.guild.id, thread.id, check.messageId);
  const sent = await target.send({
    content: [
      `🧪 **QA check needed:** ${String(check.title || thread.name).slice(0, 200)}`,
      `> The tester who filed this was asked to check the fix over ${minutesText(minutes)} ago and has not answered, so anyone can.`,
      `> Press **Take this check**: it is yours for 30 minutes and nobody else can take it. Test it in game, post a video or photo in the report's post, then press **Fixed** or **Not fixed** there.`,
    ].join('\n'),
    components: [takeButtons(check.id, checkUrl)],
    allowedMentions: { parse: [] },
  });
  await api('post', `/qa-check/${check.id}/escalated`, { channelId: target.id, messageId: sent.id });
  const message = await thread.messages.fetch(check.messageId).catch(() => null);
  if (message) {
    await message.edit({ content: `${message.content}\n\n⏰ **Not checked after ${minutesText(minutes)}**, so it is open in <#${target.id}>. Only whoever takes it there can answer now; <@${check.discordUserId}> can take it too.`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  console.log(`[QaCheck] Check ${check.id} opened up in #${target.name}`);
}

let escalating = false;
async function escalateDue() {
  if (escalating || !client) return;
  escalating = true;
  try {
    const { checks, minutes } = await api('get', '/qa-checks/due-escalation');
    for (const check of checks) {
      await escalate(check, minutes).catch(err => console.error(`[QaCheck] Could not open up check ${check.id}:`, err.response?.data?.error || err.message));
    }
  } catch (err) {
    console.error('[QaCheck] Escalation check failed:', err.response?.data?.error || err.message);
  } finally {
    escalating = false;
  }
}

// ── /qadelay ──────────────────────────────────────────────────────────────────

function getCommandDefinitions() {
  return [new SlashCommandBuilder()
    .setName('qadelay')
    .setDescription('How long a tester has to do their QA check before it goes to QA Requests')
    .addIntegerOption(o => o.setName('minutes')
      .setDescription('New wait in minutes (0 = never send checks to QA Requests). Leave out to see the current one.')
      .setMinValue(0).setMaxValue(24 * 60))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON()];
}

async function handleCommand(interaction) {
  if (interaction.commandName !== 'qadelay') return false;
  // Hidden from everyone but admins; checked again here in case a server override shows it to others.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Only server admins can change the QA Requests wait.', ephemeral: true });
    return true;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const minutes = interaction.options.getInteger('minutes');
    if (minutes === null) {
      const current = (await api('get', '/qa-escalation')).minutes;
      await interaction.editReply(current
        ? `⏱️ QA checks go to QA Requests after **${minutesText(current)}** without an answer. \`/qadelay minutes:\` changes it.`
        : '⏱️ QA checks are **not** sent to QA Requests; only the tester who filed the report can answer. `/qadelay minutes:` turns it back on.');
      return true;
    }
    const { before } = await api('post', '/qa-escalation', { minutes, changedBy: `${interaction.user.tag} (${interaction.user.id})` });
    await interaction.editReply(minutes
      ? `✅ QA checks now go to QA Requests after **${minutesText(minutes)}** without an answer (was ${before ? minutesText(before) : 'off'}). Checks already waiting that long are sent within two minutes.`
      : `✅ QA checks are no longer sent to QA Requests (was ${minutesText(before)}). Ones already there stay open.`);
  } catch (err) {
    await interaction.editReply(errorText(err));
  }
  return true;
}

function start() {
  setInterval(escalateDue, ESCALATION_POLL_MS);
  escalateDue();
}

// Someone in QA Requests pressed Take this check.
async function handleTake(interaction) {
  const checkId = interaction.customId.split(':')[1];
  await interaction.deferReply({ ephemeral: true });
  try {
    const name = interaction.member?.displayName || interaction.user.username;
    const { check, takeMinutes } = await api('post', `/qa-check/${checkId}/take`, { discordUserId: interaction.user.id, discordUserName: name });
    const checkUrl = messageUrl(interaction.guildId, check.threadId, check.messageId);
    const until = Math.floor(new Date(check.takenAt).getTime() / 1000) + takeMinutes * 60;
    await interaction.editReply([
      `🙋 **This check is yours until <t:${until}:t>.**`,
      `1. Go to the report: ${checkUrl}`,
      '2. Test the fix in game.',
      '3. Post a video or photo there showing the result.',
      '4. Press **Fixed** or **Not fixed** on the check message.',
      `Nobody else can answer or take it until then. If you have not answered by then, anyone can take it, and you would have to take it again.`,
    ].join('\n'));
    // Everyone in QA Requests and in the report's post can see who has it.
    const lines = interaction.message.content.split('\n').filter(l => !l.startsWith('🙋'));
    await interaction.message.edit({ content: [...lines, `🙋 Being checked by <@${interaction.user.id}>, until <t:${until}:t>.`].join('\n'), allowedMentions: { parse: [] } }).catch(() => {});
    const thread = await client.channels.fetch(check.threadId).catch(() => null);
    await thread?.send({ content: `🙋 <@${interaction.user.id}> has taken this QA check from QA Requests. Only they can answer it until <t:${until}:t>.`, allowedMentions: { parse: [] } }).catch(() => {});
  } catch (err) {
    await interaction.editReply(errorText(err));
  }
  return true;
}

// ── from the tester ───────────────────────────────────────────────────────────

// The newest thing the tester posted in the thread since they were asked
// that looks like proof: an uploaded video first, then a photo or any other
// upload, or a video or image link. Returns a link to that message (attachment URLs expire; this does not).
async function findProof(channel, userId, since) {
  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!fetched) return null;
  const mine = [...fetched.values()].filter(m => m.author?.id === userId && m.createdTimestamp >= since);
  const isVideo = a => (a.contentType || '').startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)(\?|$)/i.test(a.name || a.url || '');
  const withVideo = mine.find(m => [...m.attachments.values()].some(isVideo));
  const withAny = mine.find(m => m.attachments.size > 0 || VIDEO_LINK.test(m.content || ''));
  return (withVideo || withAny)?.url || null;
}

async function finish(interaction, message, check, line) {
  if (message) await message.edit({ content: `${message.content}\n\n${line}`, components: [] }).catch(() => {});
  await closeEscalation(check, line);
}

async function submit(interaction, checkId, verdict, note) {
  const { check } = await api('get', `/qa-check/${checkId}`);
  const videoUrl = await findProof(interaction.channel, interaction.user.id, new Date(check.requestedAt).getTime());
  return api('post', `/qa-check/${checkId}/respond`, {
    discordUserId: interaction.user.id,
    discordUserName: interaction.member?.displayName || interaction.user.username,
    verdict, note, videoUrl,
  });
}

const errorText = err => err.response?.data?.error || 'Something went wrong. Try again in a moment.';

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  if (interaction.customId?.startsWith('qa_take:')) return handleTake(interaction);
  if (!interaction.customId?.startsWith('qa_check:')) return false;
  const [, verdict, checkId] = interaction.customId.split(':');

  // Anyone can talk in a forum post, so the buttons answer only the tester who filed the report, or, once
  // it is open in QA Requests, whoever holds it there. Best effort, like the proof check below: the backend refuses anyone else as well.
  const { check, settings, refusal } = await api('get', `/qa-check/${checkId}?discordUserId=${interaction.user.id}`).catch(() => ({}));
  if (refusal) {
    const where = check.escalationChannelId ? ` (<#${check.escalationChannelId}>)` : '';
    await interaction.reply({ content: refusal.replace('QA Requests', `QA Requests${where}`), ephemeral: true, allowedMentions: { parse: [] } });
    return true;
  }

  if (verdict === 'notfixed') {
    // Proof is checked before the form opens, so nobody types a reason only to be told to post a photo.
    const missing = settings?.requireVideo && check?.status === 'pending'
      && !(await findProof(interaction.channel, interaction.user.id, new Date(check.requestedAt).getTime()));
    if (missing) {
      await interaction.reply({ content: 'Post a video or photo showing it still happening here first, then press Not fixed.', ephemeral: true });
      return true;
    }
    // The reason is collected next; the modal's submit does the rest.
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`qa_check_modal:${checkId}`)
      .setTitle('Not fixed')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('note').setLabel('What still happens?').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('What you did, and what happened instead of the fix').setRequired(true).setMaxLength(900))));
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await submit(interaction, checkId, 'fixed');
    await finish(interaction, interaction.message, result.check, `✅ **Confirmed fixed** by <@${interaction.user.id}>.${result.autoResolved ? ' Report resolved.' : ''}`);
    await interaction.editReply('Thanks, your check is logged.');
  } catch (err) {
    await interaction.editReply(errorText(err));
  }
  return true;
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId?.startsWith('qa_check_modal:')) return false;
  const checkId = interaction.customId.split(':')[1];
  await interaction.deferReply({ ephemeral: true });
  try {
    const note = interaction.fields.getTextInputValue('note');
    const result = await submit(interaction, checkId, 'not_fixed', note);
    await finish(interaction, interaction.message, result.check,
      `❌ **Not fixed**, according to <@${interaction.user.id}>. Sent back to the dev.\n> ${note.replace(/\s+/g, ' ').slice(0, 500)}`);
    await interaction.editReply('Thanks. It has gone back to the dev with your note.');
  } catch (err) {
    await interaction.editReply(errorText(err));
  }
  return true;
}

module.exports = { setClient, start, closeEscalation, getCommandDefinitions, handleCommand, postCheck, updateCheck, handleButton, handleModal };
