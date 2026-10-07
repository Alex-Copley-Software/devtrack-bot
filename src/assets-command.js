// assets-command.js
// /assets: the asset tracker from Discord.
//
//   /assets update [number]      summary of an update (the one in development by default)
//   /assets mine                 the caller's open tasks
//   /assets item name:<name>     an item's checklist and progress
//   /assets task id:<n> status:<status>   update one of your own tasks
//
// Registered only when ASSETS_ENABLED=true on the bot.

const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';
const ENABLED = String(process.env.ASSETS_ENABLED || '').toLowerCase() === 'true';

// Members with one of these roles can use /assets mine and nothing else.
// Discord cannot restrict a single subcommand, so the bot checks it.
const MINE_ONLY_ROLE_IDS = String(process.env.ASSETS_MINE_ONLY_ROLE_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
function isMineOnly(interaction) {
  if (!MINE_ONLY_ROLE_IDS.length) return false;
  if (interaction.memberPermissions?.has('Administrator')) return false;
  const roles = interaction.member?.roles;
  const has = id => (roles?.cache ? roles.cache.has(id) : Array.isArray(roles) && roles.includes(id));
  return MINE_ONLY_ROLE_IDS.some(has);
}

const STATUSES = ['Not Started', 'In Progress', 'Review', 'Done', 'Blocked', 'N/A'];
const MARK = { 'Not Started': '⚪', 'In Progress': '🔵', Review: '🟣', Done: '✅', Blocked: '⛔', 'N/A': '➖' };

const api = (method, path, { params, data } = {}) => axios({
  method, url: `${API_URL}/api/bot/assets${path}`, params, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout: 10000,
}).then(r => r.data);

function getCommandDefinitions() {
  if (!ENABLED) return [];
  return [
    new SlashCommandBuilder()
      .setName('assets')
      .setDescription('Asset tracker: update progress, your tasks, and item checklists')
      .addSubcommand(sub => sub.setName('update').setDescription('Summary of an update')
        .addNumberOption(opt => opt.setName('number').setDescription('Update # (defaults to the one in development)').setRequired(false)))
      .addSubcommand(sub => sub.setName('mine').setDescription('Your open asset tasks'))
      .addSubcommand(sub => sub.setName('item').setDescription("An item's checklist and progress")
        .addStringOption(opt => opt.setName('name').setDescription('Item name, e.g. Aizen').setRequired(true)))
      .addSubcommand(sub => sub.setName('task').setDescription('Update the status of one of your tasks')
        .addIntegerOption(opt => opt.setName('id').setDescription('Task number, e.g. 412').setRequired(true))
        .addStringOption(opt => opt.setName('status').setDescription('New status').setRequired(true)
          .addChoices(...STATUSES.map(s => ({ name: s, value: s })))))
      .toJSON(),
  ];
}

const pct = n => `${Math.round((n || 0) * 100)}%`;
const bar = progress => { const filled = Math.round(Math.min(1, progress || 0) * 12); return `${'█'.repeat(filled)}${'░'.repeat(12 - filled)}`; };
const openButton = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setLabel('Open Assets').setStyle(ButtonStyle.Link).setURL(`${DASHBOARD}/assets/`));
const taskLine = t => `${MARK[t.status] || '⚪'} \`#${t.ref}\` **${t.internalName}** · ${t.deliverable}${t.dueDate ? ` · due ${t.dueDate}` : ''}`;

async function showUpdate(interaction) {
  const number = interaction.options.getNumber('number');
  const { update, disciplines, attention } = await api('get', '/update', { params: number === null ? {} : { number } });
  const embed = new EmbedBuilder()
    .setTitle(`Update #${update.number} · ${update.name}`)
    .setDescription([
      `**${update.status}**${update.leadName ? ` · lead ${update.leadName}` : ''}${update.targetRelease ? ` · target ${update.targetRelease}` : ''}`,
      `${bar(update.progress)} **${pct(update.progress)}** (${update.done}/${update.countable} tasks)`,
    ].join('\n'))
    .setColor(0x7c6cf0)
    .addFields(
      { name: 'Items', value: String(update.itemCount), inline: true },
      { name: 'In review', value: String(update.review), inline: true },
      { name: 'Blocked', value: String(update.blocked), inline: true },
    );
  if (disciplines.length) {
    embed.addFields({
      name: 'By discipline',
      value: disciplines.slice(0, 15).map(d => `\`${bar(d.progress)}\` ${d.discipline} ${d.done}/${d.countable}${d.blocked ? ` · ${d.blocked} blocked` : ''}`).join('\n').slice(0, 1024),
    });
  }
  const flags = [
    attention.overdue && `${attention.overdue} overdue`,
    attention.unassignedRequired && `${attention.unassignedRequired} required tasks unassigned`,
    attention.noOwner && `${attention.noOwner} items with no owner`,
  ].filter(Boolean);
  if (flags.length) embed.addFields({ name: 'Needs attention', value: flags.join(' · ') });
  if (update.notionUrl) embed.setURL(update.notionUrl);
  return interaction.editReply({ embeds: [embed], components: [openButton()] });
}

async function showMine(interaction) {
  const { dev, tasks, total } = await api('get', '/mine', { params: { discordUserId: interaction.user.id } });
  const embed = new EmbedBuilder()
    .setTitle(`${dev.name}: ${total} open task${total === 1 ? '' : 's'}`)
    .setColor(0x60a5fa)
    .setDescription(tasks.length
      ? tasks.slice(0, 20).map(taskLine).join('\n').slice(0, 4000) + (total > 20 ? `\n...and ${total - 20} more` : '')
      : 'Nothing open. Nice.')
    .setFooter({ text: 'Update one with /assets task id:<number> status:<status>' });
  return interaction.editReply({ embeds: [embed], components: [openButton()] });
}

async function showItem(interaction) {
  const { item, update, tasks } = await api('get', '/item', { params: { name: interaction.options.getString('name') } });
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.discipline)) groups.set(t.discipline, []);
    groups.get(t.discipline).push(t);
  }
  const embed = new EmbedBuilder()
    .setTitle(`${item.internalName}${item.displayName && item.displayName !== item.internalName ? ` (${item.displayName})` : ''}`)
    .setDescription([
      `${item.contentType} · update #${update.number} ${update.name} · ${item.priority} priority${item.ownerName ? ` · owner ${item.ownerName}` : ''}`,
      `${bar(item.progress)} **${pct(item.progress)}** (${item.done}/${item.countable} tasks)${item.blocked ? ` · ${item.blocked} blocked` : ''}`,
    ].join('\n'))
    .setColor(0xa29bfe);
  for (const [discipline, list] of [...groups].slice(0, 20)) {
    embed.addFields({
      name: discipline,
      value: list.map(t => `${MARK[t.status] || '⚪'} \`#${t.ref}\` ${t.deliverable}${t.assigneeName ? ` · ${t.assigneeName}` : ''}`).join('\n').slice(0, 1024),
      inline: true,
    });
  }
  if (item.notionUrl) embed.setURL(item.notionUrl);
  return interaction.editReply({ embeds: [embed], components: [openButton()] });
}

async function setTaskStatus(interaction) {
  const { task, previousStatus } = await api('post', '/task-status', {
    data: { ref: interaction.options.getInteger('id'), status: interaction.options.getString('status'), discordUserId: interaction.user.id },
  });
  return interaction.editReply({
    content: `${MARK[task.status] || ''} \`#${task.ref}\` **${task.internalName}** · ${task.deliverable}: ${previousStatus} → **${task.status}**`,
  });
}

async function handleAssets(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'mine' && isMineOnly(interaction)) {
    return interaction.reply({ content: 'Your role can use `/assets mine` only.', ephemeral: true });
  }
  // Personal views and edits are only shown to the caller.
  await interaction.deferReply({ ephemeral: sub === 'mine' || sub === 'task' });
  try {
    if (sub === 'update') return await showUpdate(interaction);
    if (sub === 'mine') return await showMine(interaction);
    if (sub === 'item') return await showItem(interaction);
    if (sub === 'task') return await setTaskStatus(interaction);
    return interaction.editReply({ content: 'Unknown subcommand.' });
  } catch (err) {
    const message = err.response?.data?.error
      || (err.response?.status === 404 ? 'The asset tracker is not switched on yet.' : 'Could not reach the asset tracker. Try again in a moment.');
    if (!err.response) console.error('[Assets command]', err.message);
    return interaction.editReply({ content: message });
  }
}

module.exports = { getCommandDefinitions, handleAssets };
