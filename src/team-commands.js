// team-commands.js
// /team — the person who posted a bug report adds the people who helped
// find it (a multiplayer bug needs more than one player). The report's pay
// is split evenly between the reporter and the team, instead of paid to
// each. Server moderators (Manage Threads) can change any report's team.
// /leaderboard — a tester's own numbers for the current pay period (as set
// up on the payouts page): reports filed and accepted, pay earned, and their
// rank, plus what they have been paid so far. Only they see the reply.

const axios = require('axios');
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const tickets = require('./tickets');

const API_URL    = process.env.API_URL    || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const api = (method, path, data, timeout = 15000) => axios({
  method, url: `${API_URL}/api/bot${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout,
}).then(r => r.data);
const errorText = err => err.response?.data?.error
  || (err.code === 'ECONNABORTED' ? 'DevTrack took too long to answer. Try again in a minute.' : 'Something went wrong. Try again in a moment.');

function getCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('team')
      .setDescription('Who helped find this bug; the report\'s pay is split between you all (reporter only)')
      .addSubcommand(s => s.setName('add').setDescription('Add someone who helped find this bug; the pay is split with them')
        .addUserOption(o => o.setName('user').setDescription('Who to add').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Take someone off this report\'s team')
        .addUserOption(o => o.setName('user').setDescription('Who to remove').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Who is on this report\'s team'))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Your own tester stats for this pay period: reports, accepted bugs, pay and rank (only you see it)')
      .toJSON(),
  ];
}

const mentionList = ids => ids.map(id => `<@${id}>`).join(', ');

async function handleTeam(interaction, WATCHED_CHANNELS) {
  const thread = interaction.channel;
  if (tickets.reportTypeFor(thread, WATCHED_CHANNELS) !== 'bug') {
    return interaction.reply({ content: '❌ Use `/team` inside a bug report post.', ephemeral: true });
  }
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser('user');
  if (target?.bot) return interaction.reply({ content: '❌ Bots cannot be on a team.', ephemeral: true });

  await interaction.deferReply({ ephemeral: sub === 'list' });
  let report;
  try {
    report = (await api('get', `/report-by-thread/${thread.id}`)).report;
  } catch (err) {
    return interaction.editReply(err.response?.status === 404 ? '❌ No DevTrack report found for this post.' : `❌ ${errorText(err)}`);
  }

  try {
    if (sub === 'list') {
      const { team } = await api('get', `/report/${report.id}/team`);
      return interaction.editReply({
        content: team.length
          ? `👥 **Team on this report:** <@${report.discordUserId}> (reporter), ${mentionList(team.map(m => m.discordUserId))}.\n> The pay for it is split ${team.length + 1} ways.`
          : `👥 Nobody has been added to this report. <@${report.discordUserId}> can add the people who helped with \`/team add\`.`,
        allowedMentions: { parse: [] },
      });
    }

    const isReporter = interaction.user.id === report.discordUserId;
    const asAdmin = !isReporter && interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads);
    if (!isReporter && !asAdmin) return interaction.editReply('❌ Only the person who posted this report can change its team.');

    const body = {
      discordUserId: target.id, discordUser: target.tag,
      actorDiscordUserId: interaction.user.id, actorDiscordUser: interaction.user.tag, asAdmin,
    };
    const { team } = await api('post', sub === 'add' ? `/report/${report.id}/team` : `/report/${report.id}/team/remove`, body);
    const ways = team.length + 1;
    await interaction.editReply({
      content: sub === 'add'
        ? `👥 <@${target.id}> is on this report's team. If it is accepted, its pay is split ${ways} ways between <@${report.discordUserId}> and ${mentionList(team.map(m => m.discordUserId))}.`
        : `👥 <@${target.id}> is off this report's team.${team.length ? ` The pay is now split ${ways} ways.` : ' The pay goes to the reporter alone.'}`,
      allowedMentions: { users: [target.id] },
    });
  } catch (err) {
    await interaction.editReply(`❌ ${errorText(err)}`);
  }
}

const LEVELS = [['major', 'Major'], ['moderate', 'Moderate'], ['minor', 'Minor'], ['insignificant', 'Insignificant']];

async function handleLeaderboard(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const s = await api('get', `/tester-stats/${interaction.user.id}`, undefined, 60000);
    const cash = n => `${s.currency}${Number(n || 0).toFixed(2)}`;
    const day = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const levels = LEVELS.filter(([k]) => s.levels[k]).map(([k, name]) => `${name} ${s.levels[k]}`).join(' · ');
    const extras = [
      s.shared ? `${s.shared} shared with a team` : '',
      s.credited ? `${s.credited} credited to you` : '',
      s.noLevel ? `${s.noLevel} still need a bug level` : '',
    ].filter(Boolean).join(' · ');
    const range = s.period
      ? `**${s.period.name}** (${day(s.period.startsOn)} to ${day(s.period.endsOn)})${s.period.paid ? ', paid' : ''}`
      : s.from ? `**since ${day(s.from)}**, when the last pay period ended (no pay period is set up for today yet)` : '**all time** (no pay periods set up yet)';
    await interaction.editReply([
      `📊 **Your DevTrack stats:** ${range}`,
      s.rank ? `> 🏆 **#${s.rank}** of ${s.testers} testers by accepted reports` : '> 🏆 Not ranked: none of your reports have been accepted in this period.',
      `> 📝 **Filed:** ${s.filed.total} · in the queue ${s.filed.queued} · being worked on ${s.filed.active} · resolved ${s.filed.resolved} · declined ${s.filed.declined}`,
      `> ✅ **Accepted:** ${s.accepted}${levels ? ` (${levels})` : ''}`,
      extras ? `> ${extras}` : '',
      `> 🧪 **Fixes you confirmed:** ${s.verifiedFixes}`,
      s.period?.paid ? `> 💰 **Paid for this period:** ${cash(s.earned)}` : `> 💰 **Earned so far:** ${cash(s.earned)} at today's prices`,
      s.paidPeriods ? `> 💸 **Paid in total:** ${cash(s.paid)} over ${s.paidPeriods} pay period${s.paidPeriods === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join('\n'));
  } catch (err) {
    console.error('[Leaderboard] Stats failed:', err.response?.data?.error || err.message);
    await interaction.editReply(`❌ ${errorText(err)}`);
  }
}

module.exports = { getCommandDefinitions, handleTeam, handleLeaderboard };
