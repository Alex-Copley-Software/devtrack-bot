// roblox-convert.js
// Right-click a message → Apps → "Convert to Roblox": turns the .blend (+ textures) attached to that
// message into Roblox .rbxm files (plain and R6-rigged).
//
// The conversion runs on the owner's Mac (Blender + Roblox Open Cloud live there), not on Railway.
// This bot only queues the job: it DMs the owner a job card, and the Mac worker
// (~/Documents/Roblox/tools/discord_worker.py) watches that DM through the Discord API,
// does the conversion and posts the files back into the same DM. Nothing is posted publicly.
//
// Only CONVERT_OWNER_ID can run it. Off with CONVERT_ENABLED=false.

const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');

const ENABLED = String(process.env.CONVERT_ENABLED || 'true').toLowerCase() !== 'false';
const OWNER_ID = process.env.CONVERT_OWNER_ID || '618957089833877518';
const COMMAND = 'Convert to Roblox';
const MODAL = 'rbxconvert';
// The worker finds job cards by this footer; keep the two in sync.
const FOOTER = 'rbxconvert v1';
const INPUT_EXT = /\.(blend|zip|png|jpe?g|tga)$/i;

function getCommandDefinitions() {
  if (!ENABLED) return [];
  return [
    new ContextMenuCommandBuilder()
      .setName(COMMAND)
      .setType(ApplicationCommandType.Message)
      // Hidden from non-admins; the handler still checks the owner ID.
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
  ];
}

// "4.0 Upd Bleach Stark.blend" -> "UpdBleachStark", "Byakuya_Model.blend" -> "Byakuya_Model"
function nameFromFile(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/^[\d.\s_-]+/, '');
  const words = base.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 40) || 'Character';
}

async function handleContextMenu(interaction) {
  if (!ENABLED || !interaction.isMessageContextMenuCommand() || interaction.commandName !== COMMAND) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  const files = [...interaction.targetMessage.attachments.values()].filter(a => INPUT_EXT.test(a.name));
  const blend = files.find(a => /\.(blend|zip)$/i.test(a.name));
  if (!blend) {
    await interaction.reply({ content: '❌ That message has no .blend (or .zip) attached.', flags: 64 });
    return true;
  }
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL}:${interaction.targetMessage.channelId}:${interaction.targetMessage.id}`)
    .setTitle('Convert to Roblox')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('names').setLabel('Character names, left to right (comma-sep)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
        .setValue(nameFromFile(blend.name))),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('size').setLabel('Size multiplier (blank = auto)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setPlaceholder('auto')),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('rename').setLabel('Part renames, JSON (optional)')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500)
        .setPlaceholder('{"Cube.002": "Torso", "Cube.005": "LeftArm"}')),
    );
  await interaction.showModal(modal);
  return true;
}

async function handleModal(interaction) {
  if (!interaction.customId?.startsWith(`${MODAL}:`)) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  const [, channelId, messageId] = interaction.customId.split(':');
  const names = interaction.fields.getTextInputValue('names').split(',').map(s => s.trim()).filter(Boolean);
  const size = interaction.fields.getTextInputValue('size').trim() || 'auto';
  const renameText = interaction.fields.getTextInputValue('rename').trim();

  const bad = msg => interaction.reply({ content: `❌ ${msg}`, flags: 64 }).then(() => true);
  if (!names.length || names.some(n => !/^[A-Za-z0-9_]{1,40}$/.test(n))) {
    return bad('Names must be letters, digits or _ (max 40 each), separated by commas.');
  }
  if (size !== 'auto' && !(Number(size) > 0 && Number(size) <= 1000)) return bad('Size must be a number or blank.');
  let rename = null;
  if (renameText) {
    try { rename = JSON.parse(renameText); } catch { return bad('Part renames must be valid JSON.'); }
    if (typeof rename !== 'object' || Array.isArray(rename) || !rename) return bad('Part renames must be a JSON object.');
  }

  const job = { channelId, messageId, names, size, rename };
  const source = `https://discord.com/channels/${interaction.guildId || '@me'}/${channelId}/${messageId}`;
  const card = new EmbedBuilder()
    .setTitle(`⏳ Queued: ${names.join(', ')}`)
    .setColor(0xf0b232)
    .setDescription('Waiting for the Mac worker.\n```json\n' + JSON.stringify(job) + '\n```')
    .addFields({ name: 'Source', value: source })
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
  try {
    await interaction.user.send({ embeds: [card] });
  } catch (err) {
    console.error('[RobloxConvert] DM failed:', err.message);
    return bad("Couldn't DM you the job. Allow DMs from this server's members and try again.");
  }
  await interaction.reply({ content: `✅ Queued **${names.join(', ')}**. The files will arrive in your DMs.`, flags: 64 });
  console.log(`[RobloxConvert] Queued ${names.join(',')} from ${channelId}/${messageId}`);
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, handleModal, FOOTER };
