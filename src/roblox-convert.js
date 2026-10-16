// roblox-convert.js
// Right-click a message → Apps → "Convert to Roblox": turns the .blend (+ textures) attached to that
// message into Roblox .rbxm files (plain and R6-rigged).
//
// The conversion runs on the owner's Mac (Blender + Roblox Open Cloud live there), not on Railway.
// This bot only queues the job: it DMs the owner a job card, and the Mac worker
// (~/RobloxPipeline/tools/discord_worker.py) watches that DM through the Discord API,
// does the conversion and posts the files back into the same DM. Nothing is posted publicly.
//
// Right-click → Apps → "Upload Images to Roblox" queues the message's images (or a zip of them); the worker
// uploads each to the Expeditions Entertainment group as a Decal and replies with the rbxassetid:// image IDs.
//
// The worker's ✅ card carries a "Flip 180° and redo" button for characters modelled facing backwards;
// pressing it queues the same job again with flip set.
//
// Only CONVERT_OWNER_ID can run it. Off with CONVERT_ENABLED=false.

const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder,
} = require('discord.js');

const ENABLED = String(process.env.CONVERT_ENABLED || 'true').toLowerCase() !== 'false';
const OWNER_ID = process.env.CONVERT_OWNER_ID || '618957089833877518';
const COMMAND = 'Convert to Roblox';
const IMAGES_COMMAND = 'Upload Images to Roblox';
const MODAL = 'rbxconvert';
const FLIP_BUTTON = 'rbxconvert-flip'; // set by the worker on its ✅ card
// The worker finds job cards by this footer; keep the two in sync.
const FOOTER = 'rbxconvert v1';
const INPUT_EXT = /\.(blend|zip|png|jpe?g|tga)$/i;
const IMAGE_EXT = /\.(png|jpe?g|bmp|tga|zip)$/i;

function getCommandDefinitions() {
  if (!ENABLED) return [];
  // Hidden from non-admins; the handlers still check the owner ID.
  return [COMMAND, IMAGES_COMMAND].map(name => new ContextMenuCommandBuilder()
    .setName(name)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON());
}

// "4.0 Upd Bleach Stark.blend" -> "UpdBleachStark", "Byakuya_Model.blend" -> "Byakuya_Model"
function nameFromFile(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/^[\d.\s_-]+/, '');
  const words = base.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 40) || 'Character';
}

async function handleContextMenu(interaction) {
  if (!ENABLED || !interaction.isMessageContextMenuCommand()) return false;
  if (![COMMAND, IMAGES_COMMAND].includes(interaction.commandName)) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  if (interaction.commandName === IMAGES_COMMAND) return queueImages(interaction);
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
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('flip').setLabel('Turn 180°? (yes if it was modelled backwards)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setPlaceholder('no')),
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
  const flip = /^(y|yes|true|1)$/i.test(interaction.fields.getTextInputValue('flip').trim());

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

  const job = { channelId, messageId, names, size, rename, flip };
  const source = `https://discord.com/channels/${interaction.guildId || '@me'}/${channelId}/${messageId}`;
  try {
    await queue(interaction.user, job, source);
  } catch (err) {
    console.error('[RobloxConvert] DM failed:', err.message);
    return bad("Couldn't DM you the job. Allow DMs from this server's members and try again.");
  }
  await interaction.reply({ content: `✅ Queued **${names.join(', ')}**. The files will arrive in your DMs.`, flags: 64 });
  return true;
}

async function queueImages(interaction) {
  const msg = interaction.targetMessage;
  const count = [...msg.attachments.values()].filter(a => IMAGE_EXT.test(a.name)).length;
  if (!count) {
    await interaction.reply({ content: '❌ That message has no images (or .zip of images) attached.', flags: 64 });
    return true;
  }
  const job = { kind: 'images', channelId: msg.channelId, messageId: msg.id };
  const source = `https://discord.com/channels/${interaction.guildId || '@me'}/${msg.channelId}/${msg.id}`;
  const card = new EmbedBuilder()
    .setTitle(`⏳ Queued: images (${count} attachment${count === 1 ? '' : 's'})`)
    .setColor(0xf0b232)
    .setDescription('Waiting for the Mac worker.\n```json\n' + JSON.stringify(job) + '\n```')
    .addFields({ name: 'Source', value: source })
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
  try {
    await interaction.user.send({ embeds: [card] });
  } catch (err) {
    console.error('[RobloxConvert] DM failed:', err.message);
    await interaction.reply({ content: "❌ Couldn't DM you the job. Allow DMs from this server's members and try again.", flags: 64 });
    return true;
  }
  await interaction.reply({ content: '✅ Queued the images. The IDs will arrive in your DMs.', flags: 64 });
  console.log(`[RobloxConvert] Queued images from ${msg.channelId}/${msg.id}`);
  return true;
}

// The job card the Mac worker picks up (it matches on FOOTER and the ⏳ title)
async function queue(user, job, source) {
  const card = new EmbedBuilder()
    .setTitle(`⏳ Queued: ${job.names.join(', ')}${job.flip ? ' (turned 180°)' : ''}`)
    .setColor(0xf0b232)
    .setDescription('Waiting for the Mac worker.\n```json\n' + JSON.stringify(job) + '\n```')
    .addFields({ name: 'Source', value: source })
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
  await user.send({ embeds: [card] });
  console.log(`[RobloxConvert] Queued ${job.names.join(',')}${job.flip ? ' flipped' : ''} from ${job.channelId}/${job.messageId}`);
}

async function handleButton(interaction) {
  if (interaction.customId !== FLIP_BUTTON) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  const embed = interaction.message.embeds[0];
  const json = embed?.description?.match(/```json\n([\s\S]*?)\n```/);
  if (!json) {
    await interaction.reply({ content: "❌ Couldn't read the job on this card.", flags: 64 });
    return true;
  }
  const job = JSON.parse(json[1]);
  job.flip = !job.flip;
  const source = embed.fields?.find(f => f.name === 'Source')?.value || '';
  await interaction.update({ components: [] }); // one redo per card
  await queue(interaction.user, job, source);
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, handleModal, handleButton, FOOTER };
