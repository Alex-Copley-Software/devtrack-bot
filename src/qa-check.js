// qa-check.js
// Tester QA: when a report goes to QA Review, the tester who filed it is
// pinged in the report's own thread and asked to confirm the fix. They post
// a video, then press Fixed or Not fixed. The backend decides who may answer
// and records every check; this file is the Discord side only.
//
//   backend -> POST /qa-check          ask (posts the message with buttons)
//   backend -> POST /qa-check-update   staff approved it first, or it left QA Review
//   tester  -> Fixed / Not fixed       forwarded to POST /api/bot/qa-check/:id/respond

const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const api = (method, path, data) => axios({
  method, url: `${API_URL}/api/bot${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout: 15000,
}).then(r => r.data);

let client = null;
const setClient = c => { client = c; };

const VIDEO_LINK = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|streamable\.com|medal\.tv|clips\.twitch\.tv|gyazo\.com|imgur\.com|drive\.google\.com|cdn\.discordapp\.com|media\.discordapp\.net)\/\S+/i;

function buttons(checkId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qa_check:fixed:${checkId}`).setLabel('Fixed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`qa_check:notfixed:${checkId}`).setLabel('Not fixed').setStyle(ButtonStyle.Danger),
  );
}

// ── from the backend ──────────────────────────────────────────────────────────

async function postCheck({ checkId, threadId, discordUserId, title, requireVideo }) {
  if (!client) return console.error('[QaCheck] Bot is not ready yet');
  try {
    const thread = await client.channels.fetch(threadId);
    const sent = await thread.send({
      content: [
        `<@${discordUserId}> 🧪 **A fix for your report is ready for you to check.**`,
        title ? `> ${String(title).slice(0, 200)}` : '',
        `> Test it in game${requireVideo ? ', post a video or photo here showing the result,' : ''} then press a button below.`,
        `> **Fixed** if the bug is gone. **Not fixed** if it still happens.${requireVideo ? ' Either answer needs the video or photo first.' : ''}`,
      ].filter(Boolean).join('\n'),
      components: [buttons(checkId)],
      allowedMentions: { users: [discordUserId] },
    });
    await api('post', `/qa-check/${checkId}/posted`, { messageId: sent.id });
    console.log(`[QaCheck] Asked ${discordUserId} to check thread ${threadId}`);
  } catch (err) {
    console.error(`[QaCheck] Could not post the check in thread ${threadId}:`, err.response?.data?.error || err.message);
  }
}

// Staff got there first, or the report left QA Review: retire the buttons and say why.
async function updateCheck({ threadId, messageId, discordUserId, state, actorName }) {
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
    if (state === 'staff_approved' && discordUserId) {
      await thread.send({
        content: `<@${discordUserId}> ✅ Staff have approved this fix, so you do not need to check it. Thanks!`,
        allowedMentions: { users: [discordUserId] },
      });
    }
  } catch (err) {
    console.error(`[QaCheck] Could not update the check in thread ${threadId}:`, err.message);
  }
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

async function finish(interaction, message, line) {
  if (!message) return;
  await message.edit({ content: `${message.content}\n\n${line}`, components: [] }).catch(() => {});
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
  if (!interaction.isButton() || !interaction.customId?.startsWith('qa_check:')) return false;
  const [, verdict, checkId] = interaction.customId.split(':');

  if (verdict === 'notfixed') {
    // Proof is checked before the form opens, so nobody types a reason only to be told to post a photo.
    // Best effort: the backend decides for real when the form is submitted.
    const missing = await api('get', `/qa-check/${checkId}`).then(async ({ check, settings }) =>
      settings?.requireVideo && check.status === 'pending' && check.discordUserId === interaction.user.id
        && !(await findProof(interaction.channel, interaction.user.id, new Date(check.requestedAt).getTime()))).catch(() => false);
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
    await finish(interaction, interaction.message, `✅ **Confirmed fixed** by <@${interaction.user.id}>.${result.autoResolved ? ' Report resolved.' : ''}`);
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
    await submit(interaction, checkId, 'not_fixed', note);
    await finish(interaction, interaction.message,
      `❌ **Not fixed**, according to <@${interaction.user.id}>. Sent back to the dev.\n> ${note.replace(/\s+/g, ' ').slice(0, 500)}`);
    await interaction.editReply('Thanks. It has gone back to the dev with your note.');
  } catch (err) {
    await interaction.editReply(errorText(err));
  }
  return true;
}

module.exports = { setClient, postCheck, updateCheck, handleButton, handleModal };
