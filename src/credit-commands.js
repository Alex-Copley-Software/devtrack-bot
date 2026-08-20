// credit-commands.js
// /credit — the original reporter attaches another Discord user as a
// co-finder, so that person's bug count on the DevTrack leaderboard also
// reflects the find.
// /requestcredit — anyone else in the thread can ask to be credited; pings
// the report owner to confirm, and escalates to Senior Testers after 12h.

const axios = require('axios');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { SENIOR_TESTER_ROLE_ID, sendCreditAuditNotice } = require('./discord-service');

const API_URL    = process.env.API_URL    || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

function getCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('credit')
      .setDescription('Credit another user for finding this bug (report owner only)')
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('The user to credit as a co-finder')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('requestcredit')
      .setDescription('Request credit for finding this bug — pings the report owner to confirm')
      .toJSON(),
  ];
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function lookupReport(threadId) {
  try {
    const r = await axios.get(`${API_URL}/api/bot/report-by-thread/${threadId}`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    return r.data?.report || null;
  } catch { return null; }
}

function buildConfirmRow(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`credit_confirm:${requestId}`).setLabel('Confirm Credit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`credit_deny:${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
}

// ── /credit ───────────────────────────────────────────────────────────────────

async function handleCredit(interaction, WATCHED_CHANNELS) {
  const thread = interaction.channel;
  if (!thread?.isThread()) {
    return interaction.reply({ content: '❌ This command can only be used inside a bug report thread.', ephemeral: true });
  }

  const reportType = WATCHED_CHANNELS[thread.parentId];
  if (reportType !== 'bug') {
    return interaction.reply({ content: '❌ This command can only be used in bug report threads.', ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user', true);
  if (targetUser.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't credit yourself.", ephemeral: true });
  }
  if (targetUser.bot) {
    return interaction.reply({ content: "❌ You can't credit a bot.", ephemeral: true });
  }

  await interaction.deferReply();

  const report = await lookupReport(thread.id);
  if (!report) {
    return interaction.editReply({ content: '❌ No DevTrack report found for this thread.' });
  }

  if (interaction.user.id !== report.discordUserId) {
    return interaction.editReply({ content: '❌ Only the original reporter of this bug can credit someone.' });
  }

  try {
    await axios.post(`${API_URL}/api/bot/report/${report.id}/credit`, {
      creditedDiscordUserId: targetUser.id,
      creditedDiscordUser: targetUser.tag,
      actorDiscordUserId: interaction.user.id,
      actorDiscordUser: interaction.user.tag,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });

    await interaction.editReply({
      content: `✅ <@${targetUser.id}> has been credited for finding this bug, alongside <@${interaction.user.id}>.`,
      allowedMentions: { users: [targetUser.id] },
    });

    sendCreditAuditNotice({
      kind: 'credited',
      reportId: report.id,
      reportTitle: report.title,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: targetUser.id,
      targetTag: targetUser.tag,
    }).catch(() => {});
  } catch (err) {
    console.error('[Credit] Failed to credit user:', err.response?.data || err.message);
    await interaction.editReply({ content: '❌ Failed to credit that user. Please check the bot logs.' });
  }
}

// ── /requestcredit ────────────────────────────────────────────────────────────

async function handleRequestCredit(interaction, WATCHED_CHANNELS) {
  const thread = interaction.channel;
  if (!thread?.isThread()) {
    return interaction.reply({ content: '❌ This command can only be used inside a bug report thread.', ephemeral: true });
  }

  const reportType = WATCHED_CHANNELS[thread.parentId];
  if (reportType !== 'bug') {
    return interaction.reply({ content: '❌ This command can only be used in bug report threads.', ephemeral: true });
  }

  await interaction.deferReply();

  const report = await lookupReport(thread.id);
  if (!report) {
    return interaction.editReply({ content: '❌ No DevTrack report found for this thread.' });
  }

  if (interaction.user.id === report.discordUserId) {
    return interaction.editReply({ content: "❌ You're already the reporter of this bug — use `/credit` to credit someone else instead." });
  }
  if (report.creditedDiscordUserId === interaction.user.id) {
    return interaction.editReply({ content: "✅ You're already credited on this report." });
  }

  let existing = null;
  try {
    const r = await axios.get(`${API_URL}/api/bot/credit-request/existing`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      params: { reportId: report.id, requestedDiscordUserId: interaction.user.id },
      timeout: 5000,
    });
    existing = r.data;
  } catch (err) {
    console.error('[RequestCredit] Existing-check failed:', err.response?.data || err.message);
  }
  if (existing) {
    return interaction.editReply({ content: '⏳ You already have a pending credit request on this report — sit tight.' });
  }

  let request;
  try {
    const res = await axios.post(`${API_URL}/api/bot/credit-request`, {
      reportId: report.id,
      requestedDiscordUserId: interaction.user.id,
      requestedDiscordUser: interaction.user.tag,
      ownerDiscordUserId: report.discordUserId || null,
      threadId: thread.id,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });
    request = res.data;
  } catch (err) {
    console.error('[RequestCredit] Failed to create request:', err.response?.data || err.message);
    return interaction.editReply({ content: '❌ Failed to submit your credit request. Please check the bot logs.' });
  }

  const row = buildConfirmRow(request.id);
  const ownerMention = report.discordUserId ? `<@${report.discordUserId}>` : 'the report owner';
  const mentionedUsers = report.discordUserId ? [report.discordUserId, interaction.user.id] : [interaction.user.id];

  const msg = await interaction.editReply({
    content: [
      `${ownerMention} — <@${interaction.user.id}> is requesting credit for finding this bug.`,
      `> Confirm below, or this will be escalated to <@&${SENIOR_TESTER_ROLE_ID}> for review after 12 hours.`,
    ].join('\n'),
    components: [row],
    allowedMentions: { users: mentionedUsers },
  });

  try {
    await axios.patch(`${API_URL}/api/bot/credit-request/${request.id}`, {
      promptMessageId: msg.id,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
  } catch (err) {
    console.error('[RequestCredit] Failed to record prompt message id:', err.response?.data || err.message);
  }

  sendCreditAuditNotice({
    kind: 'requested',
    reportId: report.id,
    reportTitle: report.title,
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    ownerId: report.discordUserId || null,
    ownerTag: report.discordUser || null,
  }).catch(() => {});
}

// ── confirm / deny buttons ───────────────────────────────────────────────────
// Authorization depends on the request's live status, not a fixed id baked
// into the customId: the owner can act while pending, Senior Testers take
// over once it's escalated. So we re-fetch the request on every click.

async function handleCreditButton(interaction) {
  if (!interaction.isButton()) return false;
  const isConfirm = interaction.customId?.startsWith('credit_confirm:');
  const isDeny = interaction.customId?.startsWith('credit_deny:');
  if (!isConfirm && !isDeny) return false;

  const [, requestId] = interaction.customId.split(':');

  let request;
  try {
    const r = await axios.get(`${API_URL}/api/bot/credit-request/${requestId}`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    request = r.data;
  } catch (err) {
    await interaction.reply({ content: '❌ Could not look up this credit request. Please check the bot logs.', ephemeral: true });
    return true;
  }

  if (!request) {
    await interaction.reply({ content: '❌ This credit request no longer exists.', ephemeral: true });
    return true;
  }

  if (request.status === 'approved' || request.status === 'denied') {
    await interaction.reply({ content: `This request was already **${request.status}**.`, ephemeral: true });
    return true;
  }

  const isEscalated = request.status === 'escalated';
  const hasSeniorRole = interaction.member?.roles?.cache?.has(SENIOR_TESTER_ROLE_ID);

  if (isEscalated) {
    if (!hasSeniorRole) {
      await interaction.reply({ content: '❌ This request has been escalated — only Senior Testers can confirm or deny it now.', ephemeral: true });
      return true;
    }
  } else if (interaction.user.id !== request.ownerDiscordUserId) {
    await interaction.reply({ content: '❌ Only the report owner can confirm or deny this credit request.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();

  try {
    const endpoint = isConfirm ? 'approve' : 'deny';
    await axios.post(`${API_URL}/api/bot/credit-request/${requestId}/${endpoint}`, {
      resolvedByDiscordUserId: interaction.user.id,
      resolvedByDiscordUser: interaction.user.tag,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });

    const resultLine = isConfirm
      ? `✅ Credit confirmed for <@${request.requestedDiscordUserId}> by <@${interaction.user.id}>.`
      : `❌ Credit request from <@${request.requestedDiscordUserId}> was denied by <@${interaction.user.id}>.`;

    await interaction.editReply({ content: resultLine, components: [] });

    sendCreditAuditNotice({
      kind: isConfirm ? 'approved' : 'denied',
      reportId: request.reportId,
      targetId: request.requestedDiscordUserId,
      targetTag: request.requestedDiscordUser,
      resolvedById: interaction.user.id,
      resolvedByTag: interaction.user.tag,
    }).catch(() => {});
  } catch (err) {
    if (err.response?.status === 409) {
      await interaction.editReply({ content: `This request was already **${err.response.data?.request?.status || 'resolved'}**.`, components: [] });
      return true;
    }
    console.error('[CreditButton] Failed to resolve request:', err.response?.data || err.message);
    await interaction.editReply({ content: '❌ Failed to record your decision. Please check the bot logs.', components: [] });
  }

  return true;
}

// ── 12h escalation poll ──────────────────────────────────────────────────────

async function escalateStaleCreditRequests(client) {
  let escalated = [];
  try {
    const res = await axios.post(`${API_URL}/api/bot/credit-requests/escalate-stale`, {}, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 15000,
    });
    escalated = res.data || [];
  } catch (err) {
    console.error('[CreditEscalation] Failed to escalate stale requests:', err.response?.data || err.message);
    return;
  }

  for (const request of escalated) {
    try {
      const thread = await client.channels.fetch(request.threadId).catch(() => null);
      if (!thread) continue;

      const row = buildConfirmRow(request.id);
      const mentionedUsers = [request.requestedDiscordUserId, ...(request.ownerDiscordUserId ? [request.ownerDiscordUserId] : [])];

      await thread.send({
        content: [
          `<@&${SENIOR_TESTER_ROLE_ID}> — a credit request has gone unanswered for 12 hours and needs review.`,
          `> <@${request.requestedDiscordUserId}> requested credit for finding this bug${request.ownerDiscordUserId ? ` (owner: <@${request.ownerDiscordUserId}>)` : ''}.`,
        ].join('\n'),
        components: [row],
        allowedMentions: { roles: [SENIOR_TESTER_ROLE_ID], users: mentionedUsers },
      });
      console.log(`[CreditEscalation] Escalated credit request ${request.id} in thread ${request.threadId}`);
    } catch (err) {
      console.error(`[CreditEscalation] Failed to post escalation for request ${request.id}:`, err.message);
    }
  }
}

module.exports = {
  getCommandDefinitions,
  handleCredit,
  handleRequestCredit,
  handleCreditButton,
  escalateStaleCreditRequests,
};
