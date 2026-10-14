// bugs-command.js
// /bugs search: check whether a bug is already reported before opening a ticket.
//
// Reports are private tickets, so this is how other testers can see them. The
// reply is only visible to whoever ran it, and it is anonymous: the backend
// sends titles and a short summary with no reporter, no clips or images and
// no links. Shown: reports waiting for review, accepted, in progress and in QA.

const axios = require('axios');
const { EmbedBuilder, MessageFlags } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

function getCommandDefinitions() {
  return [{
    name: 'bugs',
    description: 'Check the bug reports already filed',
    options: [{
      type: 1, name: 'search', description: 'Look for an active bug report before you open a ticket',
      options: [
        { type: 3, name: 'words', description: 'What happens, e.g. "boss door stays locked"', required: true, max_length: 100 },
        { type: 3, name: 'game', description: 'Test game or live game (default: both)', required: false,
          choices: [{ name: 'Test game', value: 'test' }, { name: 'Live game', value: 'live' }] },
      ],
    }],
  }];
}

const SEVERITY = { insignificant: 'Insignificant', minor: 'Minor', moderate: 'Moderate', major: 'Major' };
const GAME = { test: 'Test game', live: 'Live game' };

function ago(when) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

async function handleBugs(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'bugs') return false;
  const words = interaction.options.getString('words', true);
  const game = interaction.options.getString('game') || '';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { data } = await axios.get(`${API_URL}/api/bot/bug-search`, {
      params: { q: words, where: game }, headers: { 'x-bot-secret': BOT_SECRET }, timeout: 15000,
    });
    const shown = data.results || [];
    const scope = game ? ` (${GAME[game]})` : '';
    if (!data.terms?.length) {
      await interaction.editReply('Give a few words about the bug, e.g. `boss door stays locked`.');
      return true;
    }
    const embed = new EmbedBuilder()
      .setColor(shown.length ? 0xffb340 : 0x30d158)
      .setTitle(shown.length ? `Already reported${scope}? ${data.total} match${data.total === 1 ? '' : 'es'}` : `Nothing active matches${scope}`)
      .setDescription(shown.length
        ? shown.map(r => {
          const facts = [r.status, r.severity ? SEVERITY[r.severity] || r.severity : null, r.where ? GAME[r.where] : null, ago(r.reportedAt)].filter(Boolean).join(' · ');
          return `**${r.title}**\n${facts}${r.summary ? `\n> ${r.summary}` : ''}`;
        }).join('\n\n').slice(0, 4000)
        : `No report that is waiting for review, accepted, in progress or in QA matches **${words.slice(0, 100)}**.\nIf you have found something new, open a ticket.`)
      .setFooter({ text: `${data.total > shown.length ? `Showing ${shown.length} of ${data.total}; add more words to narrow it. ` : ''}If yours is listed, there is no need to report it again. Reporters stay anonymous.` });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[Bugs] search failed:', err.response?.data?.error || err.message);
    await interaction.editReply('The search is not available right now. Try again in a minute.').catch(() => {});
  }
  return true;
}

module.exports = { getCommandDefinitions, handleBugs };
