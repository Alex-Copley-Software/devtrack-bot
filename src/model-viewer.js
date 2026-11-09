// model-viewer.js
// Right-click a message with a .blend → Apps → "Open in Model Viewer".
// The bot hands the file to the backend, which opens it in Blender, and replies
// (only to you) with a link to the Models page on DevTrack, where each part can
// be seen, named and exported as an FBX.
//
// Admins in the server; the owner anywhere, DMs included. Off with MODEL_VIEWER_ENABLED=false.

const axios = require('axios');
const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const ENABLED = String(process.env.MODEL_VIEWER_ENABLED || 'true').toLowerCase() !== 'false';
const COMMAND = 'Open in Model Viewer';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const DASHBOARD = (process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app').replace(/\/+$/, '');
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };
const MAX_FILES = 5;

const allowed = interaction => interaction.user.id === OWNER
  || (interaction.inCachedGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));

function getCommandDefinitions() {
  if (!ENABLED) return [];
  return [{
    ...new ContextMenuCommandBuilder().setName(COMMAND).setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    ...ANYWHERE,
  }];
}

const isBlend = a => /\.blend$/i.test(a.name || '');

async function handleContextMenu(interaction) {
  if (!interaction.isMessageContextMenuCommand?.() || interaction.commandName !== COMMAND) return false;
  if (!allowed(interaction)) {
    await interaction.reply({ content: '❌ Only admins can open models.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const message = interaction.targetMessage;
  const files = [...message.attachments.values()].filter(isBlend);
  if (!files.length) {
    const other = [...message.attachments.values()].map(a => a.name).join(', ');
    await interaction.reply({ content: `❌ There's no .blend file on that message${other ? ` (it has ${other})` : ''}.`, flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const from = message.author?.globalName || message.author?.username || '';
  const lines = [];
  for (const file of files.slice(0, MAX_FILES)) {
    try {
      const got = await axios.get(file.url, { responseType: 'arraybuffer', timeout: 120000 });
      const { data } = await axios.post(`${API_URL}/api/bot/models`, Buffer.from(got.data), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-bot-secret': process.env.BOT_SECRET,
          'x-file-name': encodeURIComponent(file.name),
          'x-uploaded-by': encodeURIComponent(from),
          'x-source-url': encodeURIComponent(message.url),
        },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000,
      });
      lines.push(`🧊 **${file.name}**: [open in the Model Viewer](<${DASHBOARD}/models/?id=${data.id}>)`);
    } catch (err) {
      const why = err.response?.data?.error || err.message;
      console.error(`[ModelViewer] ${file.name}:`, why);
      lines.push(`❌ **${file.name}**: ${why}`);
    }
  }
  if (files.length > MAX_FILES) lines.push(`-# Only the first ${MAX_FILES} .blend files were sent.`);
  lines.push('-# Blender opens it on the server, which takes a few seconds. Name each part there, then Export FBX.');
  await interaction.editReply(lines.join('\n'));
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, COMMAND };
