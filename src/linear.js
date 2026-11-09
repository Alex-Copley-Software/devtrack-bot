// linear.js
// The Linear "Assets" team, from Discord.
//
//   right-click a message → Apps → "Send to Linear"
//     its attached files go onto an issue as a comment, with a link back to the
//     message, and the issue moves to Done
//   right-click a dev's message → Apps → "Give Linear Task"
//     puts the dev's name on the end of an issue's title ("Aura - Bryan")
//   /linear      a private message with buttons, each opening a form:
//                  Give task     pick the dev, the issue, and (optionally) the name to show
//                  Remove task   takes the name back off an issue
//                  Send files    upload files from your computer onto an issue, and it moves to Done
//
// Finding the issue: its ID (ASS-12, or 12) or words from its title or its
// parent's ("doumo aura"). One match goes straight through; several give a list.
//
// The name used for each dev is remembered (by the backend) once typed, so a
// long Discord name only has to be shortened once.
//
// Who can use it: server admins in a server the bot is in, and the owner
// anywhere (DMs and group chats too, through User Install). Off unless
// LINEAR_API_KEY is set. LINEAR_TEAM picks the team (default "Assets").

const axios = require('axios');
const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, LabelBuilder, UserSelectMenuBuilder, FileUploadBuilder,
} = require('discord.js');

const KEY = process.env.LINEAR_API_KEY;
const TEAM = process.env.LINEAR_TEAM || 'Assets';
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const SEND = 'Send to Linear';
const GIVE = 'Give Linear Task';
const MODAL = 'linear-form';
const PICK = 'linear-pick';
const MENU = 'linear-menu';       // the buttons /linear posts
const MENU_FORM = 'linear-menu-form';
// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };

// What's being done, kept until the form (and, if needed, the pick) is done.
// { action: 'send', files, note, by, link, message } or { action: 'give' | 'remove', devId, name, by }
const pending = new Map();
let nextKey = 1;
function hold(job) {
  const key = String(nextKey++);
  pending.set(key, job);
  setTimeout(() => pending.delete(key), 30 * 60 * 1000).unref?.();
  return key;
}

// ── Linear ───────────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await axios.post('https://api.linear.app/graphql', { query, variables }, {
    headers: { Authorization: KEY, 'Content-Type': 'application/json' }, timeout: 20000,
  });
  if (res.data.errors?.length) throw new Error(res.data.errors.map(e => e.message).join('; '));
  return res.data.data;
}

// The team and the state its finished issues go to, looked up once.
let team = null;
async function assetsTeam() {
  if (team) return team;
  const { teams } = await gql(`query($name: String!) { teams(filter: { name: { eqIgnoreCase: $name } }) {
    nodes { id key name states { nodes { id name type position } } } } }`, { name: TEAM });
  const t = teams.nodes[0];
  if (!t) throw new Error(`There is no Linear team called "${TEAM}" that this API key can see.`);
  const completed = t.states.nodes.filter(s => s.type === 'completed').sort((a, b) => a.position - b.position);
  team = { id: t.id, key: t.key, name: t.name, done: completed.find(s => /^done$/i.test(s.name)) || completed[0] || null };
  return team;
}

const ISSUE = 'id identifier title url state { name type } team { id } parent { identifier title } project { name }';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "ASS-12" or "12" is that issue (an id picked from /linear's list too);
// anything else searches the open issues' titles and their parents'.
async function findIssues(text, first = 25) {
  const t = await assetsTeam();
  const q = String(text || '').trim();
  const ref = UUID.test(q) ? q : /^[a-z]+-\d+$/i.test(q) ? q.toUpperCase() : /^\d+$/.test(q) ? `${t.key}-${q}` : null;
  if (ref) {
    const data = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id: ref }).catch(() => null);
    const issue = data?.issue;
    return issue && issue.team.id === t.id ? [issue] : [];
  }
  // Every word has to be in the title or the parent's title: "doumo aura" is the Aura under Doumo.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const filter = { team: { id: { eq: t.id } }, state: { type: { nin: ['completed', 'canceled'] } } };
  if (words.length) filter.and = words.map(w => ({ or: [{ title: { containsIgnoreCase: w } }, { parent: { title: { containsIgnoreCase: w } } }] }));
  const { issues } = await gql(`query($filter: IssueFilter!, $first: Int!) { issues(first: $first, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE} } } }`, { filter, first });
  return issues.nodes;
}

// What an issue belongs to, for telling apart the many that share a title ("Aura").
const context = i => [i.parent ? `Part of ${i.parent.identifier} ${i.parent.title}` : i.project?.name, i.state?.name].filter(Boolean).join(' · ');

const comment = (issueId, body) => gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body } });
const updateIssue = (id, input) => gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input });

// Linear hands out a one-off upload address per file; the file goes there, and its
// lasting address goes in the comment.
async function upload(file) {
  const got = await axios.get(file.url, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: Infinity });
  const body = Buffer.from(got.data);
  const contentType = file.contentType || 'application/octet-stream';
  const { fileUpload } = await gql(`mutation($type: String!, $name: String!, $size: Int!) {
    fileUpload(contentType: $type, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }`,
  { type: contentType, name: file.name, size: body.length });
  if (!fileUpload.success) throw new Error(`Linear would not take ${file.name}`);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' };
  for (const h of fileUpload.uploadFile.headers) headers[h.key] = h.value;
  await axios.put(fileUpload.uploadFile.uploadUrl, body, { headers, timeout: 300000, maxBodyLength: Infinity, maxContentLength: Infinity });
  return { ...file, assetUrl: fileUpload.uploadFile.assetUrl };
}

async function send(job, issue) {
  const t = await assetsTeam();
  const uploaded = [];
  for (const file of job.files) uploaded.push(await upload(file));
  const lines = uploaded.map(f => (/^image\//.test(f.contentType || '') ? `![${f.name}](${f.assetUrl})` : `[${f.name}](${f.assetUrl})`));
  await comment(issue.id, [`**Delivered** by ${job.by} in Discord${job.link ? `: [message](${job.link})` : ''}`, job.note ? `\n${job.note}` : '', '', ...lines].join('\n'));
  let moved = false;
  if (t.done && issue.state?.type !== 'completed') {
    await updateIssue(issue.id, { stateId: t.done.id });
    moved = true;
  }
  const text = `✅ Sent ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} to [${issue.identifier}: ${issue.title}](<${issue.url}>)` +
    (moved ? ` and moved it to ${t.done.name}.` : t.done ? ` (it was already ${issue.state.name}).` : '. This team has no Done state, so it was left as it is.');
  // Only works where the bot is in the channel; elsewhere the reply is enough.
  await job.message?.react('✅').catch(() => {});
  return text;
}

// ── names on issues ──────────────────────────────────────────────────────────
// The bot leaves a comment each time it gives or takes back a task. The newest
// one says whose name is on the end of the title, so giving the task to someone
// else swaps the name instead of adding a second one.
const GIVEN = /^Task given to \*\*(.+?)\*\*/;
const TAKEN = /^Task taken off \*\*(.+?)\*\*/;

async function currentName(issueId) {
  const { issue } = await gql(`query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body createdAt } } } }`, { id: issueId });
  const marks = issue.comments.nodes.filter(c => GIVEN.test(c.body) || TAKEN.test(c.body)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = marks[0];
  return last && GIVEN.test(last.body) ? GIVEN.exec(last.body)[1] : null;
}

const withoutName = (title, name) => (name && title.endsWith(` - ${name}`) ? title.slice(0, -(name.length + 3)) : title);

async function give(job, issue) {
  const before = await currentName(issue.id);
  const base = withoutName(withoutName(issue.title, before), job.name);
  const title = `${base} - ${job.name}`;
  if (title !== issue.title) await updateIssue(issue.id, { title });
  await comment(issue.id, `Task given to **${job.name}** by ${job.by} in Discord.`);
  await saveName(job.devId, job.name);
  return `✅ [${issue.identifier}: ${title}](<${issue.url}>)` + (before && before !== job.name ? ` (was ${before}).` : '.');
}

async function remove(job, issue) {
  const before = await currentName(issue.id);
  if (!before) return `❌ Nobody has been given ${issue.identifier} from Discord, so there's no name to take off.`;
  const title = withoutName(issue.title, before);
  if (title !== issue.title) await updateIssue(issue.id, { title });
  await comment(issue.id, `Task taken off **${before}** by ${job.by} in Discord.`);
  return `✅ Took ${before} off [${issue.identifier}: ${title}](<${issue.url}>).`;
}

const ACTIONS = { send: [send, 'Sending files to'], give: [give, 'Giving'], remove: [remove, 'Updating'] };

// ── remembered names (backend) ───────────────────────────────────────────────
const bot = { headers: { 'x-bot-secret': BOT_SECRET }, timeout: 5000 };
// Short timeout: a right-click has 3 seconds to open its form.
const savedName = id => axios.get(`${API_URL}/api/bot/linear-names`, { ...bot, timeout: 2000, params: { ids: id } }).then(r => r.data.names[id] || null).catch(() => null);
const saveName = (id, name) => axios.put(`${API_URL}/api/bot/linear-names/${id}`, { name }, bot).catch(err => console.error('[Linear] Could not remember a name:', err.message));

// A dev's name for the title: what was used last time, or their name in the server.
async function nameFor(user, member) {
  return (await savedName(user.id)) || member?.displayName || user.globalName || user.username;
}
const cleanName = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);

// ── Discord ──────────────────────────────────────────────────────────────────

function getCommandDefinitions() {
  if (!KEY) return [];
  // Hidden from non-admins in servers; the handlers check again.
  const menu = name => ({
    ...new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    ...ANYWHERE,
  });
  const slash = new SlashCommandBuilder().setName('linear').setDescription(`Linear ${TEAM}: give or remove a task, or send files`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return [menu(SEND), menu(GIVE), { ...slash.toJSON(), ...ANYWHERE }];
}

// Server admins in a server the bot is in; the owner anywhere.
const allowed = interaction => interaction.user.id === OWNER
  || (interaction.inCachedGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));

const nope = interaction => interaction.reply({ content: '❌ Only admins can use Linear from Discord.', flags: MessageFlags.Ephemeral }).then(() => true);
const by = interaction => interaction.user.globalName || interaction.user.username;

// The form after a right-click: the issue, plus a note (sending) or the name (giving).
function form(key, title, second) {
  return new ModalBuilder().setCustomId(`${MODAL}:${key}`).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('issue').setLabel(`${TEAM} issue: ID or words from the title`)
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder(`${team ? team.key : 'ASS'}-12, or "doumo aura"`)),
    new ActionRowBuilder().addComponents(second),
  );
}

async function handleContextMenu(interaction) {
  if (!KEY || !interaction.isMessageContextMenuCommand() || ![SEND, GIVE].includes(interaction.commandName)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const message = interaction.targetMessage;
  if (interaction.commandName === GIVE) {
    // Asked before the form opens: Discord gives 3 seconds, and this is one quick call.
    const name = await nameFor(message.author, message.member);
    const key = hold({ action: 'give', devId: message.author.id, by: by(interaction) });
    await interaction.showModal(form(key, `Give ${message.author.username} a task`.slice(0, 45), new TextInputBuilder()
      .setCustomId('name').setLabel('Name on the issue').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setValue(cleanName(name))));
    return true;
  }
  const files = [...message.attachments.values()].slice(0, 10).map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null }));
  if (!files.length) {
    await interaction.reply({ content: '❌ That message has no files attached.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const key = hold({
    action: 'send', files, by: by(interaction), message,
    link: `https://discord.com/channels/${interaction.guildId || '@me'}/${message.channelId}/${message.id}`,
  });
  await interaction.showModal(form(key, SEND, new TextInputBuilder()
    .setCustomId('note').setLabel('Note for the comment (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)));
  return true;
}

async function finish(interaction, key, issue) {
  const job = pending.get(key);
  if (!job) return interaction.editReply({ content: '❌ That took too long. Try again.', components: [] });
  pending.delete(key);
  const [run, doing] = ACTIONS[job.action];
  await interaction.editReply({ content: `⏳ ${doing} **${issue.identifier}**…`, components: [] });
  try {
    await interaction.editReply(await run(job, issue));
  } catch (err) {
    console.error(`[Linear] ${job.action} failed:`, err.response?.data || err.message);
    await interaction.editReply(`❌ Could not update ${issue.identifier}: ${err.message}`);
  }
}

// Finds the issue the text means and finishes the job, or asks which one.
async function resolve(interaction, key, text) {
  let found;
  try { found = await findIssues(text); } catch (err) {
    console.error('[Linear] search failed:', err.response?.data || err.message);
    await interaction.editReply(`❌ Could not reach Linear: ${err.message}`);
    return;
  }
  if (!found.length) {
    await interaction.editReply(`❌ No open issue in the ${TEAM} team matches that. Try its ID (like ${(team && team.key) || 'ASS'}-12).`);
    return;
  }
  if (found.length === 1) { await finish(interaction, key, found[0]); return; }
  pending.get(key).choices = new Map(found.map(i => [i.id, i]));
  await interaction.editReply({
    content: `${found.length} issues match. Which one?`,
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PICK}:${key}`).setPlaceholder('Pick the issue')
      .addOptions(found.map(i => ({ label: `${i.identifier}: ${i.title}`.slice(0, 100), value: i.id, description: context(i).slice(0, 100) || undefined }))))],
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
  const job = pending.get(key);
  if (job?.action === 'send') job.note = interaction.fields.getTextInputValue('note').trim();
  if (job?.action === 'give') job.name = cleanName(interaction.fields.getTextInputValue('name'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!job) { await interaction.editReply('❌ That took too long. Try again.'); return true; }
  await resolve(interaction, key, interaction.fields.getTextInputValue('issue'));
  return true;
}

async function handleSelect(interaction) {
  if (!interaction.customId?.startsWith(`${PICK}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const key = interaction.customId.slice(PICK.length + 1);
  const issue = pending.get(key)?.choices?.get(interaction.values[0]);
  await interaction.deferUpdate();
  if (!issue) {
    await interaction.editReply({ content: '❌ That took too long. Try again.', components: [] });
    return true;
  }
  await finish(interaction, key, issue);
  return true;
}

// /linear: a private message with a button per job.
async function handleCommand(interaction) {
  if (!KEY || !interaction.isChatInputCommand() || interaction.commandName !== 'linear') return false;
  if (!allowed(interaction)) return nope(interaction);
  await interaction.reply({
    content: `**Linear · ${TEAM}**: what do you want to do?`,
    flags: MessageFlags.Ephemeral,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${MENU}:give`).setLabel('Give task').setEmoji('🧑‍💻').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${MENU}:remove`).setLabel('Remove task').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${MENU}:send`).setLabel('Send files').setEmoji('📎').setStyle(ButtonStyle.Secondary),
    )],
  });
  return true;
}

const issueField = () => new LabelBuilder().setLabel(`${TEAM} issue`).setDescription('Its ID, or words from its title or its parent\'s')
  .setTextInputComponent(new TextInputBuilder().setCustomId('issue').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    .setPlaceholder(`${team ? team.key : 'ASS'}-12, or "doumo aura"`));

const MENU_FORMS = {
  give: () => new ModalBuilder().setCustomId(`${MENU_FORM}:give`).setTitle('Give a task').addLabelComponents(
    new LabelBuilder().setLabel('Dev').setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('dev').setRequired(true).setMaxValues(1)),
    issueField(),
    new LabelBuilder().setLabel('Name on the issue (optional)').setDescription('Blank: the name used last time, or their server name')
      .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)),
  ),
  remove: () => new ModalBuilder().setCustomId(`${MENU_FORM}:remove`).setTitle('Remove a task').addLabelComponents(issueField()),
  send: () => new ModalBuilder().setCustomId(`${MENU_FORM}:send`).setTitle('Send files to Linear').addLabelComponents(
    new LabelBuilder().setLabel('Files').setDescription('Up to 10. The issue moves to Done.')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setRequired(true).setMinValues(1).setMaxValues(10)),
    issueField(),
    new LabelBuilder().setLabel('Note for the comment (optional)')
      .setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
  ),
};

// A button on /linear's message opens its form.
async function handleButton(interaction) {
  if (!interaction.customId?.startsWith(`${MENU}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const make = MENU_FORMS[interaction.customId.slice(MENU.length + 1)];
  if (!make) return false;
  await interaction.showModal(make());
  return true;
}

// A form from /linear's buttons.
async function handleMenuForm(interaction) {
  const action = interaction.customId.slice(MENU_FORM.length + 1);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const issue = interaction.fields.getTextInputValue('issue');
  if (action === 'remove') {
    await resolve(interaction, hold({ action: 'remove', by: by(interaction) }), issue);
  } else if (action === 'give') {
    const user = interaction.fields.getSelectedUsers('dev')?.first();
    if (!user) { await interaction.editReply('❌ Pick the dev.'); return true; }
    const member = interaction.fields.getSelectedMembers('dev')?.first();
    const name = cleanName(interaction.fields.getTextInputValue('name')) || cleanName(await nameFor(user, member));
    await resolve(interaction, hold({ action: 'give', devId: user.id, name, by: by(interaction) }), issue);
  } else if (action === 'send') {
    const files = [...(interaction.fields.getUploadedFiles('files')?.values() || [])].slice(0, 10)
      .map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null }));
    if (!files.length) { await interaction.editReply('❌ Add at least one file.'); return true; }
    await resolve(interaction, hold({ action: 'send', files, note: interaction.fields.getTextInputValue('note').trim(), by: by(interaction) }), issue);
  }
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, handleModal, handleSelect, handleCommand, handleButton };
