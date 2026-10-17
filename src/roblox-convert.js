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
// Right-click → Apps → "Upload Icons to Roblox" frames the images like the Figma icon setup (80×80 in a
// 120×120 frame, PNG 2×; tools/roblox-icon) and posts a preview card first. Its buttons turn the art
// (↺/↻ 15° or 45°, or "Set angle…") by putting the card back in the queue with a new "rotate"; "Upload"
// queues it with upload set, and only then does anything go to Roblox.
//
// "Accessory? yes" in the form converts swords, guns and other props instead: no rig, no auto-size,
// one plain Name.rbxm per item.
//
// The worker's ✅ card carries a "Flip 180° and redo" button for characters modelled facing backwards;
// pressing it queues the same job again with flip set.
//
// Both commands work anywhere: servers, the bot's DM, and other DMs and group chats (User Install).
// The bot can't read other people's DMs, so the job carries the attachment links Discord hands it
// with the right-click; the worker downloads from those.
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
const ICONS_COMMAND = 'Upload Icons to Roblox';
const MODAL = 'rbxconvert';
const ICON_MODAL = 'rbxicon';
const FLIP_BUTTON = 'rbxconvert-flip'; // set by the worker on its ✅ card
// Set by the worker on its 👀 icon preview card: rbxicon-rot:<degrees>, rbxicon-angle, rbxicon-upload
const ICON_ROTATE = 'rbxicon-rot:';
const ICON_ANGLE = 'rbxicon-angle';
const ICON_UPLOAD = 'rbxicon-upload';
// The worker finds job cards by this footer; keep the two in sync.
const FOOTER = 'rbxconvert v1';
const INPUT_EXT = /\.(blend|zip|png|jpe?g|tga)$/i;
const IMAGE_EXT = /\.(png|jpe?g|bmp|tga|zip)$/i;
// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };

// Attachments of the right-clicked message, kept until its form is submitted (the modal can't carry them)
const pendingFiles = new Map();
const filesOf = (message, ext) => [...message.attachments.values()]
  .filter(a => ext.test(a.name)).slice(0, 10).map(a => ({ name: a.name, url: a.url }));

function getCommandDefinitions() {
  if (!ENABLED) return [];
  // Hidden from non-admins in servers; the handlers still check the owner ID.
  return [COMMAND, IMAGES_COMMAND, ICONS_COMMAND].map(name => ({
    ...new ContextMenuCommandBuilder()
      .setName(name)
      .setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    ...ANYWHERE,
  }));
}

// "4.0 Upd Bleach Stark.blend" -> "UpdBleachStark", "Byakuya_Model.blend" -> "Byakuya_Model"
function nameFromFile(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/^[\d.\s_-]+/, '');
  const words = base.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 40) || 'Character';
}

async function handleContextMenu(interaction) {
  if (!ENABLED || !interaction.isMessageContextMenuCommand()) return false;
  if (![COMMAND, IMAGES_COMMAND, ICONS_COMMAND].includes(interaction.commandName)) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  if (interaction.commandName === IMAGES_COMMAND) return queueImages(interaction);
  if (interaction.commandName === ICONS_COMMAND) return askIcons(interaction);
  const files = [...interaction.targetMessage.attachments.values()].filter(a => INPUT_EXT.test(a.name));
  const blend = files.find(a => /\.(blend|zip)$/i.test(a.name));
  if (!blend) {
    await interaction.reply({ content: '❌ That message has no .blend (or .zip) attached.', flags: 64 });
    return true;
  }
  const key = `${interaction.targetMessage.channelId}:${interaction.targetMessage.id}`;
  pendingFiles.set(key, filesOf(interaction.targetMessage, INPUT_EXT));
  setTimeout(() => pendingFiles.delete(key), 30 * 60 * 1000).unref?.();
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL}:${interaction.targetMessage.channelId}:${interaction.targetMessage.id}`)
    .setTitle('Convert to Roblox')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('names').setLabel('Names, left to right (comma-sep)')
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
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('accessory').setLabel('Accessory? (yes for swords/guns: no rig)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setPlaceholder('no')),
    );
  await interaction.showModal(modal);
  return true;
}

async function handleModal(interaction) {
  if (interaction.customId?.startsWith(`${ICON_MODAL}:`) || interaction.customId === ICON_ANGLE) {
    return handleIconModal(interaction);
  }
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
  const accessory = /^(y|yes|true|1)$/i.test(interaction.fields.getTextInputValue('accessory').trim());

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

  // Without files (bot restarted mid-form) the worker fetches the message itself, which works where the bot is
  const files = pendingFiles.get(`${channelId}:${messageId}`);
  pendingFiles.delete(`${channelId}:${messageId}`);
  const job = { channelId, messageId, names, size, rename, flip, ...(accessory ? { accessory } : {}), ...(files ? { files } : {}) };
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
  const files = filesOf(msg, IMAGE_EXT);
  const count = files.length;
  if (!count) {
    await interaction.reply({ content: '❌ That message has no images (or .zip of images) attached.', flags: 64 });
    return true;
  }
  const job = { kind: 'images', channelId: msg.channelId, messageId: msg.id, files };
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

// "45", "-30°", "" -> degrees clockwise in -180..180, or NaN
function parseAngle(text) {
  const t = String(text).replace(/[°\s]/g, '');
  const deg = t ? Number(t) : 0;
  return Number.isFinite(deg) ? normAngle(deg) : NaN;
}
const normAngle = deg => {
  const d = ((Math.round(deg * 10) / 10) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
};

const angleField = value => new ActionRowBuilder().addComponents(new TextInputBuilder()
  .setCustomId('rotate').setLabel('Rotate, degrees clockwise (e.g. 45 or -30)')
  .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8).setPlaceholder('0')
  .setValue(value ? String(value) : ''));

async function askIcons(interaction) {
  const msg = interaction.targetMessage;
  const files = filesOf(msg, IMAGE_EXT);
  if (!files.length) {
    await interaction.reply({ content: '❌ That message has no images (or .zip of images) attached.', flags: 64 });
    return true;
  }
  const key = `${msg.channelId}:${msg.id}`;
  pendingFiles.set(key, files);
  setTimeout(() => pendingFiles.delete(key), 30 * 60 * 1000).unref?.();
  const modal = new ModalBuilder()
    .setCustomId(`${ICON_MODAL}:${msg.channelId}:${msg.id}`)
    .setTitle('Upload Icons to Roblox')
    .addComponents(
      angleField(0),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('name').setLabel('Name (blank = file name; several = Name_1…)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)
        .setValue(files.length === 1 ? nameFromFile(files[0].name) : '')),
    );
  await interaction.showModal(modal);
  return true;
}

// The ⏳ icon card; the worker turns it into a 👀 preview (or ✅ after upload) in place
function iconCard(job, source) {
  const turned = job.rotate ? `, turned ${job.rotate}°` : '';
  return new EmbedBuilder()
    .setTitle(`⏳ Queued: icons (${job.upload ? 'upload' : 'preview'}${turned})`)
    .setColor(0xf0b232)
    .setDescription('Waiting for the Mac worker.\n```json\n' + JSON.stringify(job) + '\n```')
    .addFields({ name: 'Source', value: source || '-' })
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
}

function jobOf(message) {
  const embed = message?.embeds?.[0];
  const json = embed?.description?.match(/```json\n([\s\S]*?)\n```/);
  if (!json) return null;
  return { job: JSON.parse(json[1]), source: embed.fields?.find(f => f.name === 'Source')?.value || '' };
}

// Back into the queue on the same card: the old preview and buttons go until the worker posts the new one
const requeueIcons = (interaction, job, source) =>
  interaction.update({ embeds: [iconCard(job, source)], components: [], attachments: [] }).then(() => true);

async function handleIconModal(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  const bad = msg => interaction.reply({ content: `❌ ${msg}`, flags: 64 }).then(() => true);
  const rotate = parseAngle(interaction.fields.getTextInputValue('rotate'));
  if (Number.isNaN(rotate)) return bad('Rotation must be a number of degrees, like 45 or -30.');

  if (interaction.customId === ICON_ANGLE) { // "Set angle…" on a preview card
    const card = jobOf(interaction.message);
    if (!card) return bad("Couldn't read the job on this card.");
    return requeueIcons(interaction, { ...card.job, rotate, upload: false }, card.source);
  }
  const [, channelId, messageId] = interaction.customId.split(':');
  const name = interaction.fields.getTextInputValue('name').trim();
  if (name && !/^[A-Za-z0-9_]{1,40}$/.test(name)) return bad('Name must be letters, digits or _ (max 40).');
  const files = pendingFiles.get(`${channelId}:${messageId}`);
  pendingFiles.delete(`${channelId}:${messageId}`);
  const job = { kind: 'icons', channelId, messageId, rotate, ...(name ? { name } : {}), upload: false, ...(files ? { files } : {}) };
  const source = `https://discord.com/channels/${interaction.guildId || '@me'}/${channelId}/${messageId}`;
  try {
    await interaction.user.send({ embeds: [iconCard(job, source)] });
  } catch (err) {
    console.error('[RobloxConvert] DM failed:', err.message);
    return bad("Couldn't DM you the job. Allow DMs from this server's members and try again.");
  }
  await interaction.reply({ content: '✅ Queued. A preview will arrive in your DMs; nothing is uploaded until you press Upload.', flags: 64 });
  console.log(`[RobloxConvert] Queued icons from ${channelId}/${messageId}`);
  return true;
}

async function handleIconButton(interaction) {
  const card = jobOf(interaction.message);
  if (!card || card.job.kind !== 'icons') {
    await interaction.reply({ content: "❌ Couldn't read the job on this card.", flags: 64 });
    return true;
  }
  const { job, source } = card;
  if (interaction.customId === ICON_ANGLE) {
    await interaction.showModal(new ModalBuilder().setCustomId(ICON_ANGLE).setTitle('Set angle')
      .addComponents(angleField(job.rotate || 0)));
    return true;
  }
  if (interaction.customId === ICON_UPLOAD) return requeueIcons(interaction, { ...job, upload: true }, source);
  const step = Number(interaction.customId.slice(ICON_ROTATE.length)) || 0;
  return requeueIcons(interaction, { ...job, rotate: normAngle((job.rotate || 0) + step), upload: false }, source);
}

// The job card the Mac worker picks up (it matches on FOOTER and the ⏳ title)
async function queue(user, job, source) {
  const card = new EmbedBuilder()
    .setTitle(`⏳ Queued: ${job.names.join(', ')}${job.accessory ? ' (accessory)' : ''}${job.flip ? ' (turned 180°)' : ''}`)
    .setColor(0xf0b232)
    .setDescription('Waiting for the Mac worker.\n```json\n' + JSON.stringify(job) + '\n```')
    .addFields({ name: 'Source', value: source })
    .setFooter({ text: FOOTER })
    .setTimestamp(new Date());
  await user.send({ embeds: [card] });
  console.log(`[RobloxConvert] Queued ${job.names.join(',')}${job.flip ? ' flipped' : ''} from ${job.channelId}/${job.messageId}`);
}

async function handleButton(interaction) {
  const icon = interaction.customId.startsWith(ICON_ROTATE) || [ICON_ANGLE, ICON_UPLOAD].includes(interaction.customId);
  if (interaction.customId !== FLIP_BUTTON && !icon) return false;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: '❌ Only the owner can run this.', flags: 64 });
    return true;
  }
  if (icon) return handleIconButton(interaction);
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
