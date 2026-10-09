// asset-payouts.js
// Dev payout requests, Discord side.
//
//   dev posts in the "Payments" post of their own forum
//     -> the API reads it: a request, too vague, or just chat
//     -> too vague: the bot asks what it is for
//     -> a request: the bot confirms to the dev and forwards it to the
//        admins' payouts channel with Paid out / Decline buttons
//   admin presses Paid out (or marks it on the Assets page)
//     -> a tick on the dev's message and a reply mentioning them
//
// The API decides everything (whose forum it is, what the request covers,
// duplicates, who may press the buttons). This file only talks to Discord.

const axios = require('axios');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, StringSelectMenuBuilder,
} = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';
const api = (method, path, data, timeout = 15000) => axios({
  method, url: `${API_URL}/api/bot/assets${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout,
}).then(r => r.data);

let config = { enabled: false, adminChannelId: '', managerRoleId: '' };
// Set by the agent: whether a channel id is one the agent reads (a dev's forum, for instance).
let isReadChannel = () => false;
const setScope = fn => { isReadChannel = fn; };
const configure = next => { config = { enabled: !!next?.enabled, adminChannelId: next?.adminChannelId || '', managerRoleId: next?.managerRoleId || '' }; };

// A dev's "Payments" post: a thread with that name. Whether its forum belongs
// to a dev on the roster is checked by the API.
const isPaymentsPost = channel => !!channel?.isThread?.() && /^\W*(payments?|payouts?)\W*$/i.test(channel.name || '');

// ── the admins' channel ───────────────────────────────────────────────────────

let warned = false;
async function adminChannel(client, guildId, preferredId) {
  const id = preferredId || config.adminChannelId;
  if (id) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel?.send) return channel;
  }
  // Not set yet: use the channel called "payouts".
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const channels = guild ? await guild.channels.fetch().catch(() => null) : null;
  // Any channel the bot can post in whose name is "payouts", allowing for
  // decoration around it ("💰︱payouts", "admin-payouts").
  // The admins' "channel" may well be a forum post, like their other admin
  // posts, so open posts and threads count too. A dev's own Payments post does not.
  const threads = guild ? await guild.channels.fetchActiveThreads().catch(() => null) : null;
  const posts = [...(threads?.threads?.values() || [])].filter(t => !isReadChannel(t.parentId));
  const named = [...(channels?.values() || []), ...posts].filter(c => c && /payouts?/i.test(c.name || '') && !/^\W*payments?\W*$/i.test(c.name));
  const usable = named.filter(c => typeof c.send === 'function' && c.permissionsFor(client.user)?.has(['ViewChannel', c.isThread?.() ? 'SendMessagesInThreads' : 'SendMessages', 'EmbedLinks']));
  const found = usable.find(c => /^\W*payouts?\W*$/i.test(c.name)) || usable[0] || null;
  if (!found && !warned) {
    warned = true;
    const seen = named.map(c => {
      const perms = c.permissionsFor(client.user);
      const missing = ['ViewChannel', c.isThread?.() ? 'SendMessagesInThreads' : 'SendMessages', 'EmbedLinks'].filter(x => !perms?.has(x));
      return `"${c.name}" (${ChannelType[c.type]}${typeof c.send === 'function' ? '' : ', not a channel messages can be sent to'}${missing.length ? `, bot is missing ${missing.join(' + ')}` : ''})`;
    });
    console.error(`[AssetPayouts] No admin payouts channel the bot can post in. ${seen.length ? `Found: ${seen.join('; ')}` : 'No channel with "payout" in its name is visible to the bot.'}`);
  }
  return found;
}

const STATE = {
  pending: { color: 0xfbbf24, label: 'Waiting to be paid' },
  paid: { color: 0x34d399, label: 'Paid out' },
  declined: { color: 0xf87171, label: 'Declined' },
};

function robloxField(account) {
  const v = String(account || '');
  if (!v) return 'Not given';
  if (/^https?:\/\//i.test(v)) return `[Profile](${v})`;
  if (/^\d+$/.test(v)) return `[ID ${v}](https://www.roblox.com/users/${v}/profile)`;
  return `[${v}](https://www.roblox.com/search/users?keyword=${encodeURIComponent(v)})`;
}

function adminEmbed(p) {
  const state = STATE[p.status] || STATE.pending;
  const tasks = (p.tasks || []).map(t => `\`#${t.ref}\` ${t.item} · ${t.deliverable}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`Payout request · ${p.devName || 'Unknown dev'}`)
    .setColor(state.color)
    .setDescription(`**${p.amountText || 'No amount given'}** for **${p.description || 'unspecified work'}**`)
    .addFields(
      { name: 'Dev', value: p.discordUserId ? `<@${p.discordUserId}>` : p.devName || 'Unknown', inline: true },
      { name: 'Roblox', value: robloxField(p.robloxAccount), inline: true },
      { name: 'Item', value: p.itemName || 'Not matched', inline: true },
      { name: 'Status', value: `${state.label}${p.status !== 'pending' && p.resolvedByName ? ` by ${p.resolvedByName}` : ''}`, inline: true },
      { name: 'Tracker tasks', value: tasks.slice(0, 1000) || 'None matched. Check what this covers before paying.' },
    )
    .setTimestamp(new Date(p.createdAt || Date.now()));
  if (p.text) embed.addFields({ name: 'They wrote', value: `>>> ${String(p.text).slice(0, 900)}` });
  if (p.requestUrl) embed.addFields({ name: 'Request', value: `[Open the message](${p.requestUrl})`, inline: true });
  if (p.robloxNote && p.status === 'pending') embed.addFields({ name: 'Different Roblox account from the one on file', value: String(p.robloxNote).slice(0, 500) });
  const dupes = Array.isArray(p.duplicates) ? p.duplicates : [];
  if (dupes.length) {
    embed.addFields({
      name: dupes.some(d => d.status === 'paid') ? 'Possible duplicate: something here was already PAID' : 'Possible duplicate: another request covers this',
      value: dupes.map(d => `${d.status === 'paid' ? 'Paid' : 'Requested'} ${d.amountText || ''} for ${d.description || 'unspecified'}${d.requestUrl ? ` ([message](${d.requestUrl}))` : ''}`).join('\n').slice(0, 1000),
    });
    if (p.status === 'pending') embed.setColor(0xf87171);
  }
  // From the Revenue page's expense log: what this dev was paid lately.
  const history = Array.isArray(p.paymentHistory) ? p.paymentHistory : [];
  if (history.length && p.status === 'pending') {
    embed.addFields({
      name: 'Recent payments to them (Revenue)',
      value: history.slice(0, 5).map(h => `${h.date || 'no date'} · ${Number(h.amount || 0).toLocaleString('en-US')} · ${String(h.description || '').slice(0, 70)}`).join('\n').slice(0, 1000),
    });
  }
  if (p.status === 'paid') {
    embed.addFields({ name: 'Revenue', value: p.revenueExpenseId
      ? `Logged as expense #${p.revenueExpenseId}, ${Array.isArray(p.costSharePersonIds) && p.costSharePersonIds.length ? `split across ${p.costSharePersonIds.length} chosen ${p.costSharePersonIds.length === 1 ? 'person' : 'people'}` : 'default split'}`
      : p.revenueNote || 'Not logged' });
  }
  if (p.status === 'declined' && p.declineReason) embed.addFields({ name: 'Why', value: String(p.declineReason).slice(0, 500) });
  return embed;
}

const buttons = id => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`asset_pay:paid:${id}`).setLabel('Paid out').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`asset_pay:decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setLabel('All payouts').setStyle(ButtonStyle.Link).setURL(`${DASHBOARD}/assets/#/payouts`),
);

// ── a message in a Payments post ──────────────────────────────────────────────

async function handleMessage(message, payload) {
  if (!config.enabled) return;
  let result;
  try {
    result = await api('post', '/payout-request', { message: payload }, 120000);
  } catch (err) {
    if (![403, 404].includes(err.response?.status)) console.error('[AssetPayouts] Could not read a payout request:', err.response?.data?.error || err.message);
    return;
  }
  if (result.action === 'ask') {
    const help = result.managerRoleId ? `<@&${result.managerRoleId}> can help` : 'a manager can help';
    await message.reply({
      content: `${result.reply}\n-# Not sure what to put? ${help[0].toUpperCase()}${help.slice(1)}.`,
      allowedMentions: { repliedUser: true, roles: result.managerRoleId ? [result.managerRoleId] : [] },
    }).catch(err => console.error('[AssetPayouts] Could not ask for details:', err.message));
    return;
  }
  if (result.action !== 'logged') return;

  const p = result.payout;
  const forwarded = await forward(message.client, { ...p, guildId: message.guildId });
  console.log(`[AssetPayouts] ${p.devName}: ${p.amountText || 'no amount'} for ${p.description}${forwarded ? '' : ' (NOT forwarded, see above)'}`);
  await message.reply({
    content: forwarded ? result.reply : `${result.reply.split('. I have passed')[0]}. It is logged, but I could not reach the admins' channel, so let a manager know.`,
    allowedMentions: { repliedUser: false, parse: [] },
  }).catch(() => {});
}

// ── applying a decision to Discord ────────────────────────────────────────────

async function forward(client, p) {
  const channel = await adminChannel(client, p.guildId, null);
  if (!channel) return false;
  try {
    const sent = await channel.send({ embeds: [adminEmbed(p)], components: [buttons(p.id)], allowedMentions: { parse: [] } });
    await api('post', `/payouts/${p.id}/posted`, { adminChannelId: channel.id, adminMessageId: sent.id });
    warned = false;
    console.log(`[AssetPayouts] Forwarded ${p.devName}'s request to #${channel.name}`);
    return true;
  } catch (err) {
    console.error(`[AssetPayouts] Could not post in the admin channel ${channel.id}:`, err.message);
    return false;
  }
}

async function applyUpdate(client, p) {
  // Logged earlier but never forwarded (the admin channel was not reachable then).
  if (p.status === 'pending' && !p.adminMessageId) { await forward(client, p); return; }
  // The admins' card.
  if (p.adminChannelId && p.adminMessageId) {
    const channel = await client.channels.fetch(p.adminChannelId).catch(() => null);
    const card = channel ? await channel.messages.fetch(p.adminMessageId).catch(() => null) : null;
    if (card) await card.edit({ embeds: [adminEmbed(p)], components: p.status === 'pending' ? [buttons(p.id)] : [] }).catch(() => {});
  }
  // The dev's post.
  if (!p.channelId) return;
  const thread = await client.channels.fetch(p.channelId).catch(() => null);
  if (!thread) return;
  const original = p.messageId ? await thread.messages.fetch(p.messageId).catch(() => null) : null;
  const mention = p.discordUserId ? `<@${p.discordUserId}> ` : '';
  const what = `${p.amountText ? `**${p.amountText}** ` : ''}for **${p.description || 'your request'}**`;
  const send = content => {
    const options = { content, allowedMentions: { users: p.discordUserId ? [p.discordUserId] : [], repliedUser: false } };
    return (original ? original.reply(options) : thread.send(options)).catch(err => console.error('[AssetPayouts] Could not reply to the dev:', err.message));
  };
  if (p.status === 'paid') {
    if (original) await original.react('✅').catch(() => {});
    await send(`${mention}✅ Paid out: ${what}.`);
  } else if (p.status === 'declined') {
    if (original) await original.react('❌').catch(() => {});
    await send(`${mention}This payout request was declined: ${what}.${p.declineReason ? `\n> ${p.declineReason}` : ''}`);
  } else if (original) {
    // Reopened: take the bot's own marks back off.
    for (const emoji of ['✅', '❌']) await original.reactions.cache.get(emoji)?.users.remove(client.user.id).catch(() => {});
  }
}

// ── buttons ───────────────────────────────────────────────────────────────────

async function decide(interaction, id, decision, reason, costSharePersonIds) {
  try {
    const p = await api('post', `/payouts/${id}/resolve`, {
      decision, reason, costSharePersonIds,
      discordUserId: interaction.user.id,
      actorName: interaction.member?.displayName || interaction.user.username,
      isAdministrator: !!interaction.memberPermissions?.has('Administrator'),
    });
    await applyUpdate(interaction.client, p);
    return null;
  } catch (err) {
    return err.response?.data?.error || 'Something went wrong. Try again, or use the Payouts page.';
  }
}

async function handleButton(interaction) {
  if (!interaction.isButton() || !interaction.customId?.startsWith('asset_pay:')) return false;
  const [, action, id] = interaction.customId.split(':');
  if (action === 'decline') {
    await interaction.showModal(new ModalBuilder().setCustomId(`asset_pay_modal:${id}`).setTitle('Decline payout request')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('reason').setLabel('Why? (the dev sees this)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(280))));
    return true;
  }
  // "Paid out" on the card. When the Revenue page is on, the payout is logged
  // there as an expense, and an expense needs to know who splits its cost:
  // ask, privately, before anything is marked.
  if (action === 'paid') {
    const people = await api('get', '/payout-audience').then(r => r.people || []).catch(() => []);
    if (!people.length) {
      await interaction.deferUpdate();
      const error = await decide(interaction, id, 'paid');
      if (error) await interaction.followUp({ content: error, ephemeral: true }).catch(() => {});
      return true;
    }
    const shown = people.slice(0, 25); // a Discord menu holds 25
    await interaction.reply({
      ephemeral: true,
      content: `**Who pays for this one?** It will be logged on the Revenue page as an expense.\nPick the people who split it, or use the default: an even split across all ${people.length} manual-payout shareholders.${people.length > 25 ? '\n-# Only the first 25 are listed here; for anyone else, edit the expense on the Revenue page afterwards.' : ''}`,
      components: [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
          .setCustomId(`asset_pay_who:${id}`).setPlaceholder('Choose who splits it').setMinValues(1).setMaxValues(shown.length)
          .addOptions(shown.map(p => ({ label: String(p.name).slice(0, 100), value: String(p.id) })))),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`asset_pay:paidall:${id}`).setLabel(`Default: split across all ${people.length}`).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`asset_pay:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)),
      ],
    });
    return true;
  }
  if (action === 'cancel') {
    await interaction.update({ content: 'Cancelled. Nothing was marked.', components: [] });
    return true;
  }
  // 'paidall': the default split, chosen from the private prompt.
  await interaction.deferUpdate();
  const error = await decide(interaction, id, 'paid');
  await interaction.editReply({ content: error || 'Marked as paid, split across everyone. The dev has been told.', components: [] }).catch(() => {});
  return true;
}

// The people picked in the private "who pays" menu.
async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu() || !interaction.customId?.startsWith('asset_pay_who:')) return false;
  const id = interaction.customId.split(':')[1];
  await interaction.deferUpdate();
  const error = await decide(interaction, id, 'paid', null, interaction.values.map(Number));
  await interaction.editReply({
    content: error || `Marked as paid, split across ${interaction.values.length} ${interaction.values.length === 1 ? 'person' : 'people'}. The dev has been told.`, components: [],
  }).catch(() => {});
  return true;
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId?.startsWith('asset_pay_modal:')) return false;
  await interaction.deferReply({ ephemeral: true });
  const error = await decide(interaction, interaction.customId.split(':')[1], 'declined', interaction.fields.getTextInputValue('reason'));
  await interaction.editReply(error || 'Declined. The dev has been told why.').catch(() => {});
  return true;
}

module.exports = { configure, setScope, isPaymentsPost, handleMessage, applyUpdate, handleButton, handleModal, handleSelect };
