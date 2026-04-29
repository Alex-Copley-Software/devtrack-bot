// track-command.js
// /track — replies with the DevTrack dashboard link for the current thread

const axios = require('axios');

const API_URL    = process.env.API_URL    || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD  = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';

/**
 * Returns the slash command definition to register with Discord.
 */
function getCommandDefinition() {
  return {
    name: 'track',
    description: 'Get the DevTrack dashboard link for this report',
  };
}

/**
 * Handles the /track interaction.
 * Must be called from your interactionCreate handler when interaction.commandName === 'track'.
 */
async function handleTrack(interaction) {
  // /track only makes sense inside a thread
  const threadId = interaction.channelId;

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await axios.get(`${API_URL}/api/bot/report-by-thread/${threadId}`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });

    const reportId = response.data?.reportId;
    if (!reportId) {
      return interaction.editReply({
        content: '❌ No DevTrack report found for this thread.',
      });
    }

    const link = `${DASHBOARD}#report/${reportId}`;

    return interaction.editReply({
      content: `🔗 **DevTrack Report**\n${link}`,
    });

  } catch (err) {
    if (err.response?.status === 404) {
      return interaction.editReply({
        content: '❌ No DevTrack report is linked to this thread.',
      });
    }
    console.error('[Track] Error:', err.message);
    return interaction.editReply({
      content: '⚠️ Something went wrong looking up this report.',
    });
  }
}

module.exports = { getCommandDefinition, handleTrack };