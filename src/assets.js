// assets.js
// The Assets board on DevTrack, from Discord.
//
//   right-click a message → Apps → "Send to Assets"
//     lists the author's tasks (in progress, done in the last two weeks, and the
//     open subtasks under each) to pick from, or search any task; the message's
//     link (and the names of its files) is saved on the task, the task moves to
//     Done, and it becomes the author's if it wasn't. The files stay on Discord.
//   right-click a dev's message → Apps → "Give Assets Task"
//     pick the task; it goes In Progress with the author on it
//   /assets      a private message with buttons, each opening a form:
//                  Give task     pick the dev and the task
//                  Remove task   takes the dev off a task, back to Untasked
//                  Get links     posts the links saved on a task in the channel
//
// Finding a task: its ID (ASS-12, or 12) or words from the card's, the parent
// task's or its own name ("doumo aura", "doumo icons equipment"). One match goes
// straight through; several give a list.
//
// Someone given a task who isn't on the Developers tab yet is added under their
// server name. Who can use it: server admins in a server the bot is in, and the
// owner anywhere (DMs and group chats too, through User Install).

const axios = require('axios');
const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, LabelBuilder, UserSelectMenuBuilder,
} = require('discord.js');

const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const API_URL = process.env.API_URL || 'http://localhost:3001';
const DASHBOARD = (process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app').replace(/\/+$/, '');
const SEND = 'Send to Assets';
const GIVE = 'Give Assets Task';
const MODAL = 'assets-form';
const PICK = 'assets-pick';
const SEARCH = 'assets-search';   // "Search for the task" under Send to Assets' list
const MENU = 'assets-menu';       // the buttons /assets posts
const MENU_FORM = 'assets-menu-form';
// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };

const api = { headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 15000 };
const get = (path, params) => axios.get(`${API_URL}/api/bot/board${path}`, { ...api, params }).then(r => r.data);
const post = (path, body) => axios.post(`${API_URL}/api/bot/board${path}`, body, api).then(r => r.data);
const why = err => err.response?.data?.error || err.message;

// The dots on the devs' places follow who has something in progress.
const refreshDots = () => require('./dev-status').refreshSoon();

// What's being done, kept until the form (and, if needed, the pick) is done.
//   { action: 'send', url, files, author: {id, name}, by, message }
//   { action: 'give', dev: {id, name}, by }   { action: 'remove', by }   { action: 'links', by }
const pending = new Map();
let nextKey = 1;
function hold(job) {
  const key = String(nextKey++);
  pending.set(key, job);
  setTimeout(() => pending.delete(key), 30 * 60 * 1000).unref?.();
  return key;
}

const STATUS = { untasked: 'Untasked', in_progress: 'In progress', done: 'Done' };
const describe = t => [STATUS[t.status], t.devName].filter(Boolean).join(' · ');
const option = t => ({ label: `${t.identifier}: ${t.label}`.slice(0, 100), value: t.id, description: describe(t).slice(0, 100) || undefined });
const link = t => `[${t.identifier}: ${t.label}](<${DASHBOARD}/assets/?item=${encodeURIComponent(t.identifier)}>)`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── what each job does ───────────────────────────────────────────────────────

async function send(job, task) {
  const r = await post('/deliver', { task: task.id, url: job.url, files: job.files, discordUserId: job.author.id, name: job.author.name, by: job.by });
  refreshDots();
  await job.message?.react('✅').catch(() => {});
  return `✅ Saved the link${job.files.length ? ` (${plural(job.files.length, 'file')})` : ''} on ${link(r.task)}` +
    (r.was === 'done' ? ' (it was already Done).' : ' and marked it **Done**.') + (r.dev ? `\n-# It's ${r.dev}'s.` : '');
}

async function give(job, task) {
  const r = await post('/give', { task: task.id, discordUserId: job.dev.id, name: job.dev.name, by: job.by });
  refreshDots();
  return `✅ ${link(r.task)} is **In progress** with **${r.dev}**` + (r.was ? ` (was ${r.was}).` : '.');
}

async function remove(job, task) {
  const r = await post('/remove', { task: task.id, by: job.by });
  refreshDots();
  return `✅ Took ${r.was || 'the dev'} off ${link(r.task)}; it's back to **Untasked**.`;
}

// Posts the links saved on a task in the channel, for everyone there.
async function links(job, task, interaction) {
  const { deliveries } = await get('/deliveries', { task: task.id });
  if (!deliveries.length) return `There are no links saved on ${link(task)} yet. Right-click a message → Apps → **${SEND}** to save one.`;
  const lines = deliveries.slice(0, 15).map(d => `• ${d.url}${d.files.length ? ` · ${d.files.slice(0, 4).join(', ')}${d.files.length > 4 ? '…' : ''}` : ''}${d.devName ? ` · ${d.devName}` : ''}`);
  await interaction.followUp({ content: [`📎 ${link(task)}, shared by ${job.by}`, ...lines].join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
  return `✅ Posted ${plural(Math.min(deliveries.length, 15), 'link')} from ${task.identifier}.`;
}

const ACTIONS = { send: [send, 'Saving the link on'], give: [give, 'Giving'], remove: [remove, 'Updating'], links: [links, 'Getting the links on'] };

// ── Discord ──────────────────────────────────────────────────────────────────

function getCommandDefinitions() {
  // Hidden from non-admins in servers; the handlers check again.
  const menu = name => ({
    ...new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    ...ANYWHERE,
  });
  const slash = new SlashCommandBuilder().setName('assets').setDescription('The Assets board: give or remove a task, or get the links saved on one')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return [menu(SEND), menu(GIVE), { ...slash.toJSON(), ...ANYWHERE }];
}

// Server admins in a server the bot is in; the owner anywhere.
const allowed = interaction => interaction.user.id === OWNER
  || (interaction.inCachedGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
const nope = interaction => interaction.reply({ content: '❌ Only admins can use the Assets board from Discord.', flags: MessageFlags.Ephemeral }).then(() => true);
const by = interaction => interaction.user.globalName || interaction.user.username;
const nameOf = (user, member) => member?.displayName || user.globalName || user.username;

const taskInput = () => new TextInputBuilder().setCustomId('task').setLabel('Task: its ID or words from the card and task')
  .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder('ASS-12, or "doumo aura"');
const form = (key, title) => new ModalBuilder().setCustomId(`${MODAL}:${key}`).setTitle(title.slice(0, 45))
  .addComponents(new ActionRowBuilder().addComponents(taskInput()));

async function handleContextMenu(interaction) {
  if (!interaction.isMessageContextMenuCommand() || ![SEND, GIVE].includes(interaction.commandName)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const message = interaction.targetMessage;
  const author = { id: message.author.id, name: nameOf(message.author, message.member) };
  if (interaction.commandName === GIVE) {
    const key = hold({ action: 'give', dev: author, by: by(interaction) });
    await interaction.showModal(form(key, `Give ${author.name} a task`));
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const files = [...message.attachments.values()].slice(0, 10).map(a => a.name);
  const key = hold({
    action: 'send', files, author, by: by(interaction), message,
    url: message.url || `https://discord.com/channels/${interaction.guildId || '@me'}/${message.channelId}/${message.id}`,
  });
  let tasks = [];
  try { ({ tasks } = await get('/dev-tasks', { discordUserId: author.id })); } catch (err) {
    console.error('[Assets] Could not list the dev\'s tasks:', why(err));
  }
  const rows = [];
  if (tasks.length) {
    pending.get(key).choices = new Map(tasks.map(t => [t.id, t]));
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PICK}:${key}`).setPlaceholder(`${author.name}'s tasks`)
      .addOptions(tasks.slice(0, 25).map(option))));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SEARCH}:${key}`)
    .setLabel(tasks.length ? 'Another task…' : 'Search for the task').setEmoji('🔎').setStyle(tasks.length ? ButtonStyle.Secondary : ButtonStyle.Primary)));
  await interaction.editReply({
    content: `Send **${author.name}**'s message to the Assets board${files.length ? ` (${plural(files.length, 'file')})` : ''}. ` +
      (tasks.length ? 'Pick one of their tasks, or search for another.' : `${author.name} has nothing in progress or recently done, so search for the task.`) +
      '\n-# The link to the message is saved on the task (the files stay on Discord), and the task moves to Done.',
    components: rows,
  });
  return true;
}

async function finish(interaction, key, task) {
  const job = pending.get(key);
  if (!job) return interaction.editReply({ content: '❌ That took too long. Try again.', components: [] });
  pending.delete(key);
  const [run, doing] = ACTIONS[job.action];
  await interaction.editReply({ content: `⏳ ${doing} **${task.identifier}**…`, components: [] });
  try {
    await interaction.editReply({ content: await run(job, task, interaction), components: [] });
  } catch (err) {
    console.error(`[Assets] ${job.action} failed:`, why(err));
    await interaction.editReply({ content: `❌ Could not update ${task.identifier}: ${why(err)}`, components: [] });
  }
}

// Finds the task the text means and finishes the job, or asks which one.
async function resolve(interaction, key, text) {
  const job = pending.get(key);
  const withDone = ['send', 'links'].includes(job?.action);
  let found;
  try { ({ tasks: found } = await get('/search', { q: text, done: withDone ? '1' : '0' })); } catch (err) {
    console.error('[Assets] search failed:', why(err));
    await interaction.editReply({ content: `❌ Could not reach DevTrack: ${why(err)}`, components: [] });
    return;
  }
  if (!found.length) {
    await interaction.editReply({ content: `❌ No ${withDone ? '' : 'open '}task matches that. Try its ID (like ASS-12) or the card's name and the task's.`, components: [] });
    return;
  }
  if (found.length === 1) { await finish(interaction, key, found[0]); return; }
  job.choices = new Map(found.map(t => [t.id, t]));
  await interaction.editReply({
    content: `${found.length} tasks match. Which one?`,
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PICK}:${key}`).setPlaceholder('Pick the task')
      .addOptions(found.slice(0, 25).map(option)))],
  });
}

async function handleModal(interaction) {
  if (interaction.customId?.startsWith(`${MENU_FORM}:`)) {
    if (!allowed(interaction)) return nope(interaction);
    return handleMenuForm(interaction);
  }
  if (!interaction.customId?.startsWith(`${MODAL}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const key = interaction.customId.slice(MODAL.length + 1);
  // A form opened from the task list replaces that list; one from a right-click gets its own reply.
  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!pending.get(key)) { await interaction.editReply({ content: '❌ That took too long. Try again.', components: [] }); return true; }
  await resolve(interaction, key, interaction.fields.getTextInputValue('task'));
  return true;
}

async function handleSelect(interaction) {
  if (!interaction.customId?.startsWith(`${PICK}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const key = interaction.customId.slice(PICK.length + 1);
  const task = pending.get(key)?.choices?.get(interaction.values[0]);
  await interaction.deferUpdate();
  if (!task) { await interaction.editReply({ content: '❌ That took too long. Try again.', components: [] }); return true; }
  await finish(interaction, key, task);
  return true;
}

// /assets: a private message with a button per job.
async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'assets') return false;
  if (!allowed(interaction)) return nope(interaction);
  await interaction.reply({
    content: `**Assets board**: what do you want to do? · [Open it](<${DASHBOARD}/assets/>)`,
    flags: MessageFlags.Ephemeral,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${MENU}:give`).setLabel('Give task').setEmoji('🧑‍💻').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${MENU}:remove`).setLabel('Remove task').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${MENU}:links`).setLabel('Get links').setEmoji('📎').setStyle(ButtonStyle.Secondary),
    )],
  });
  return true;
}

const taskField = () => new LabelBuilder().setLabel('Task').setDescription('Its ID, or words from the card\'s and the task\'s names')
  .setTextInputComponent(new TextInputBuilder().setCustomId('task').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    .setPlaceholder('ASS-12, or "doumo aura"'));
const devField = () => new LabelBuilder().setLabel('Dev').setDescription('Who the task is for')
  .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('dev').setRequired(true).setMaxValues(1));

const MENU_FORMS = {
  give: () => new ModalBuilder().setCustomId(`${MENU_FORM}:give`).setTitle('Give a task').addLabelComponents(devField(), taskField()),
  remove: () => new ModalBuilder().setCustomId(`${MENU_FORM}:remove`).setTitle('Remove a task').addLabelComponents(taskField()),
  links: () => new ModalBuilder().setCustomId(`${MENU_FORM}:links`).setTitle('Get the links on a task').addLabelComponents(taskField()),
};

// /assets's buttons open their form; "Search for the task" opens the search form for Send to Assets.
async function handleButton(interaction) {
  if (interaction.customId?.startsWith(`${SEARCH}:`)) {
    if (!allowed(interaction)) return nope(interaction);
    const key = interaction.customId.slice(SEARCH.length + 1);
    if (!pending.get(key)) { await interaction.update({ content: '❌ That took too long. Right-click the message again.', components: [] }); return true; }
    await interaction.showModal(form(key, SEND));
    return true;
  }
  if (!interaction.customId?.startsWith(`${MENU}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const make = MENU_FORMS[interaction.customId.slice(MENU.length + 1)];
  if (!make) return false;
  await interaction.showModal(make());
  return true;
}

// A form from /assets's buttons.
async function handleMenuForm(interaction) {
  const action = interaction.customId.slice(MENU_FORM.length + 1);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = interaction.fields.getTextInputValue('task');
  if (action === 'give') {
    const user = interaction.fields.getSelectedUsers('dev')?.first();
    if (!user) { await interaction.editReply('❌ Pick the dev.'); return true; }
    const member = interaction.fields.getSelectedMembers('dev')?.first();
    await resolve(interaction, hold({ action: 'give', dev: { id: user.id, name: nameOf(user, member) }, by: by(interaction) }), text);
  } else if (action === 'remove' || action === 'links') {
    await resolve(interaction, hold({ action, by: by(interaction) }), text);
  }
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, handleModal, handleSelect, handleCommand, handleButton };
