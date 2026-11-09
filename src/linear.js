// linear.js
// The Linear "Assets" team, from Discord.
//
//   right-click a dev's message → Apps → "Give Linear Task"
//     puts the dev's name on the end of an issue's title ("Aura - Bryan") and
//     moves it to In Progress, which turns their forum's dot 🟢 (linear-status.js)
//   right-click a message with files → Apps → "Send to Linear"
//     lists the tasks that dev has in progress to pick from, or search any
//     issue; the files go on as a comment, the dev's name goes on the title if
//     it wasn't, and the issue moves to Done
//   /linear      a private message with buttons, each opening a form:
//                  Give task     pick the dev, the issue, and (optionally) the name to show
//                  Remove task   takes the name back off an issue, back to Todo
//                  Send files    upload files from your computer onto an issue, and it moves to Done
//
// Finding an issue: its ID (ASS-12, or 12) or words from its title or its
// parent's ("doumo aura"). One match goes straight through; several give a list.
//
// A dev's name on titles: what was typed for them last time (kept by the
// backend), else their name on the asset roster, else their server name.
// Names already on titles are recognised whether the bot or a person put them there.
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
const SEARCH = 'linear-search';   // "Search for the issue" under Send to Linear's task list
const MENU = 'linear-menu';       // the buttons /linear posts
const MENU_FORM = 'linear-menu-form';
// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };

// The dots on the devs' forums follow what's in progress; told to look again after each change.
const refreshDots = () => require('./linear-status').refreshSoon();

// What's being done, kept until the form (and, if needed, the pick) is done.
//   { action: 'send', files, note, by, link?, message?, devId?, name? }
//   { action: 'give', devId, name, by }   { action: 'remove', by }
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

// The team and its Todo / In Progress / Done states, looked up once.
let team = null;
async function assetsTeam() {
  if (team) return team;
  const { teams } = await gql(`query($name: String!) { teams(filter: { name: { eqIgnoreCase: $name } }) {
    nodes { id key name states { nodes { id name type position } } } } }`, { name: TEAM });
  const t = teams.nodes[0];
  if (!t) throw new Error(`There is no Linear team called "${TEAM}" that this API key can see.`);
  const state = (type, name) => {
    const all = t.states.nodes.filter(s => s.type === type).sort((a, b) => a.position - b.position);
    return all.find(s => name.test(s.name)) || all[0] || null;
  };
  team = { id: t.id, key: t.key, name: t.name, todo: state('unstarted', /^todo$/i), started: state('started', /^in progress$/i), done: state('completed', /^done$/i) };
  return team;
}

const ISSUE = 'id identifier title url state { name type } team { id } parent { identifier title } project { name }';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "ASS-12" or "12" is that issue; anything else searches the open issues'
// titles and their parents'.
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

// Everything in progress in the team.
async function startedIssues() {
  const t = await assetsTeam();
  const { issues } = await gql(`query($team: ID!) { issues(first: 250, filter: { team: { id: { eq: $team } }, state: { type: { eq: "started" } } }) {
    nodes { ${ISSUE} } } }`, { team: t.id });
  return issues.nodes;
}

// What an issue belongs to, for telling apart the many that share a title ("Aura").
const context = i => [i.parent ? `Part of ${i.parent.identifier} ${i.parent.title}` : i.project?.name, i.state?.name].filter(Boolean).join(' · ');

const comment = (issueId, body) => gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body } });
const updateIssue = (id, input) => gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input });

// ── who's who ────────────────────────────────────────────────────────────────
const bot = { headers: { 'x-bot-secret': BOT_SECRET } };

// The asset roster (name, Discord account, status forum) from the backend,
// and the names typed for each dev. Looked up at most every five minutes.
let directory = null;
let directoryAt = 0;
async function devDirectory(fresh = false) {
  if (directory && !fresh && Date.now() - directoryAt < 5 * 60 * 1000) return directory;
  const roster = await axios.get(`${API_URL}/api/bot/assets/dev-status`, { ...bot, timeout: 8000 }).then(r => r.data.devs || []).catch(() => []);
  const ids = roster.map(d => d.discordUserId).filter(Boolean);
  const saved = ids.length ? await axios.get(`${API_URL}/api/bot/linear-names`, { ...bot, timeout: 8000, params: { ids: ids.join(',') } }).then(r => r.data.names).catch(() => ({})) : {};
  const byId = new Map(roster.filter(d => d.discordUserId).map(d => [d.discordUserId, { ...d, saved: saved[d.discordUserId] || null }]));
  directory = { roster, byId, saved };
  directoryAt = Date.now();
  return directory;
}

const lower = s => String(s || '').trim().toLowerCase();
// Every name a dev might have on a title.
const namesOf = (dir, id, extra = []) => [...new Set([dir.saved[id], dir.byId.get(id)?.name, ...extra].filter(Boolean).map(lower))];
// The name on the end of a title ("Texture - Ruku" -> "Ruku"), if it's one of these.
function nameOnTitle(title, names) {
  const m = / - ([^-]+)$/.exec(title || '');
  return m && names.has(lower(m[1])) ? m[1].trim() : null;
}
function allNames(dir) {
  return new Set([...Object.values(dir.saved), ...dir.roster.map(d => d.name)].filter(Boolean).map(lower));
}

// A dev's tasks in progress: In Progress issues with one of their names on the end.
async function activeTasksFor(devId, extraNames = []) {
  const dir = await devDirectory();
  const names = new Set(namesOf(dir, devId, extraNames));
  if (!names.size) return [];
  return (await startedIssues()).filter(i => nameOnTitle(i.title, names));
}

// Whose name is on an issue now. The bot leaves a comment each time it gives or
// takes back a task, and the newest says; failing that, a known dev's name on
// the end of the title (put there by hand) counts.
const GIVEN = /^Task given to \*\*(.+?)\*\*/;
const TAKEN = /^Task taken off \*\*(.+?)\*\*/;
async function currentName(issue) {
  const { issue: found } = await gql(`query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body createdAt } } } }`, { id: issue.id });
  const marks = found.comments.nodes.filter(c => GIVEN.test(c.body) || TAKEN.test(c.body)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (marks[0] && GIVEN.test(marks[0].body)) {
    const name = GIVEN.exec(marks[0].body)[1];
    if (issue.title.endsWith(` - ${name}`)) return name;
  }
  if (marks[0] && TAKEN.test(marks[0].body)) return null;
  return nameOnTitle(issue.title, allNames(await devDirectory()));
}

const withoutName = (title, name) => (name && title.endsWith(` - ${name}`) ? title.slice(0, -(name.length + 3)) : title);

// Puts a name on the end of the title, swapping out whoever was there.
async function putName(issue, name, by) {
  const before = await currentName(issue);
  if (before === name) return { title: issue.title, before };
  const title = `${withoutName(withoutName(issue.title, before), name)} - ${name}`;
  await updateIssue(issue.id, { title });
  await comment(issue.id, `Task given to **${name}** by ${by} in Discord.`);
  return { title, before };
}

const remember = (id, name) => id && name && axios.put(`${API_URL}/api/bot/linear-names/${id}`, { name }, { ...bot, timeout: 8000 })
  .then(() => { directoryAt = 0; })
  .catch(err => console.error('[Linear] Could not remember a name:', err.message));

// A dev's name for a title: the one typed last time, their roster name, or their server name.
async function nameFor(user, member, timeout) {
  const dir = await Promise.race([devDirectory(), new Promise(r => setTimeout(() => r(null), timeout || 8000))]);
  const known = dir?.byId.get(user.id);
  return dir?.saved[user.id] || known?.name || member?.displayName || user.globalName || user.username;
}
const cleanName = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);

// ── what each job does ───────────────────────────────────────────────────────

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
  // The dev's name goes on the title if it wasn't already (it wasn't given to them first).
  let title = issue.title;
  if (job.name) {
    ({ title } = await putName(issue, job.name, job.by));
    await remember(job.devId, job.name);
  }
  const uploaded = [];
  for (const file of job.files) uploaded.push(await upload(file));
  const lines = uploaded.map(f => (/^image\//.test(f.contentType || '') ? `![${f.name}](${f.assetUrl})` : `[${f.name}](${f.assetUrl})`));
  await comment(issue.id, [`**Delivered**${job.name ? ` by ${job.name}` : ''}, sent by ${job.by} in Discord${job.link ? `: [message](${job.link})` : ''}`,
    job.note ? `\n${job.note}` : '', '', ...lines].join('\n'));
  let moved = false;
  if (t.done && issue.state?.type !== 'completed') {
    await updateIssue(issue.id, { stateId: t.done.id });
    moved = true;
  }
  refreshDots();
  // Only works where the bot is in the channel; elsewhere the reply is enough.
  await job.message?.react('✅').catch(() => {});
  return `✅ Sent ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} to [${issue.identifier}: ${title}](<${issue.url}>)` +
    (moved ? ` and moved it to ${t.done.name}.` : t.done ? ` (it was already ${issue.state.name}).` : '. This team has no Done state, so it was left as it is.');
}

async function give(job, issue) {
  const t = await assetsTeam();
  const { title, before } = await putName(issue, job.name, job.by);
  if (t.started && issue.state?.type !== 'started') await updateIssue(issue.id, { stateId: t.started.id });
  await remember(job.devId, job.name);
  refreshDots();
  return `✅ [${issue.identifier}: ${title}](<${issue.url}>) is ${t.started?.name || 'given'}` + (before && before !== job.name ? ` (was ${before}).` : '.');
}

async function remove(job, issue) {
  const t = await assetsTeam();
  const before = await currentName(issue);
  if (!before) return `❌ ${issue.identifier} has no dev's name on it to take off.`;
  const title = withoutName(issue.title, before);
  const input = title !== issue.title ? { title } : {};
  if (t.todo && issue.state?.type === 'started') input.stateId = t.todo.id;
  if (Object.keys(input).length) await updateIssue(issue.id, input);
  await comment(issue.id, `Task taken off **${before}** by ${job.by} in Discord.`);
  refreshDots();
  return `✅ Took ${before} off [${issue.identifier}: ${title}](<${issue.url}>)${input.stateId ? `, back to ${t.todo.name}` : ''}.`;
}

const ACTIONS = { send: [send, 'Sending files to'], give: [give, 'Giving'], remove: [remove, 'Updating'] };

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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const short = (id, label, value, required = true) => new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
  .setRequired(required).setMaxLength(id === 'issue' ? 100 : 40).setValue(value || '');
const issueInput = () => new TextInputBuilder().setCustomId('issue').setLabel(`${TEAM} issue: ID or words from the title`)
  .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder(`${team ? team.key : 'ASS'}-12, or "doumo aura"`);
const noteInput = () => new TextInputBuilder().setCustomId('note').setLabel('Note for the comment (optional)')
  .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
const nameInput = name => short('name', 'Dev name on the issue', cleanName(name));

// A form whose answers go to the job held under key.
const form = (key, title, inputs) => new ModalBuilder().setCustomId(`${MODAL}:${key}`).setTitle(title.slice(0, 45))
  .addComponents(...inputs.map(i => new ActionRowBuilder().addComponents(i)));

async function handleContextMenu(interaction) {
  if (!KEY || !interaction.isMessageContextMenuCommand() || ![SEND, GIVE].includes(interaction.commandName)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const message = interaction.targetMessage;
  if (interaction.commandName === GIVE) {
    // The form has to open within 3 seconds, so the name lookup gets 2.
    const name = await nameFor(message.author, message.member, 2000);
    const key = hold({ action: 'give', devId: message.author.id, by: by(interaction) });
    await interaction.showModal(form(key, `Give ${message.author.username} a task`, [issueInput(), nameInput(name)]));
    return true;
  }

  const files = [...message.attachments.values()].slice(0, 10).map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null }));
  if (!files.length) {
    await interaction.reply({ content: '❌ That message has no files attached.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // The files are this dev's work: offer what they have in progress first.
  const dev = message.author;
  const name = cleanName(await nameFor(dev, message.member));
  const key = hold({
    action: 'send', files, by: by(interaction), message, devId: dev.id, name,
    link: `https://discord.com/channels/${interaction.guildId || '@me'}/${message.channelId}/${message.id}`,
  });
  let tasks = [];
  try { tasks = await activeTasksFor(dev.id, [name]); } catch (err) {
    console.error('[Linear] Could not list tasks in progress:', err.message);
  }
  const rows = [];
  if (tasks.length) {
    pending.get(key).choices = new Map(tasks.map(i => [i.id, i]));
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PICK}:${key}`).setPlaceholder(`${name}'s tasks in progress`)
      .addOptions(tasks.slice(0, 25).map(i => ({ label: `${i.identifier}: ${i.title}`.slice(0, 100), value: i.id, description: context(i).slice(0, 100) || undefined })))));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SEARCH}:${key}`)
    .setLabel(tasks.length ? 'Another issue…' : 'Search for the issue').setEmoji('🔎').setStyle(tasks.length ? ButtonStyle.Secondary : ButtonStyle.Primary)));
  await interaction.editReply({
    content: `Send ${plural(files.length, 'file')} from **${name}** to Linear. ` +
      (tasks.length ? `Pick one of their tasks in progress, or search for another issue.` : `${name} has nothing in progress, so search for the issue.`) +
      '\n-# It moves to Done. An issue that isn\'t theirs gets their name put on it.',
    components: rows,
  });
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
    await interaction.editReply({ content: `❌ Could not reach Linear: ${err.message}`, components: [] });
    return;
  }
  if (!found.length) {
    await interaction.editReply({ content: `❌ No open issue in the ${TEAM} team matches that. Try its ID (like ${(team && team.key) || 'ASS'}-12).`, components: [] });
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
  const field = id => { try { return interaction.fields.getTextInputValue(id); } catch { return null; } };
  if (job && field('note') !== null) job.note = field('note').trim();
  if (job && field('name') !== null) job.name = cleanName(field('name')) || job.name;
  // A form opened from the task list replaces that list; one from a right-click gets its own reply.
  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!job) { await interaction.editReply({ content: '❌ That took too long. Try again.', components: [] }); return true; }
  await resolve(interaction, key, field('issue'));
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
const devField = required => new LabelBuilder().setLabel(required ? 'Dev' : 'Dev (optional)')
  .setDescription(required ? 'Who the task is for' : 'Whose work it is: their name goes on the issue if it isn\'t already')
  .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('dev').setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(1));
const nameField = () => new LabelBuilder().setLabel('Name on the issue (optional)').setDescription('Blank: the name used last time, their roster name, or their server name')
  .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40));

const MENU_FORMS = {
  give: () => new ModalBuilder().setCustomId(`${MENU_FORM}:give`).setTitle('Give a task').addLabelComponents(devField(true), issueField(), nameField()),
  remove: () => new ModalBuilder().setCustomId(`${MENU_FORM}:remove`).setTitle('Remove a task').addLabelComponents(issueField()),
  send: () => new ModalBuilder().setCustomId(`${MENU_FORM}:send`).setTitle('Send files to Linear').addLabelComponents(
    new LabelBuilder().setLabel('Files').setDescription('Up to 10. The issue moves to Done.')
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setRequired(true).setMinValues(1).setMaxValues(10)),
    issueField(), devField(false), nameField(),
    new LabelBuilder().setLabel('Note for the comment (optional)').setTextInputComponent(noteInput()),
  ),
};

// /linear's buttons open their form; "Search for the issue" opens the search form for Send to Linear.
async function handleButton(interaction) {
  if (interaction.customId?.startsWith(`${SEARCH}:`)) {
    if (!allowed(interaction)) return nope(interaction);
    const key = interaction.customId.slice(SEARCH.length + 1);
    const job = pending.get(key);
    if (!job) { await interaction.update({ content: '❌ That took too long. Right-click the message again.', components: [] }); return true; }
    await interaction.showModal(form(key, SEND, [issueInput(), nameInput(job.name), noteInput()]));
    return true;
  }
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
  const pickedDev = async () => {
    const user = interaction.fields.getSelectedUsers('dev')?.first();
    if (!user) return {};
    const member = interaction.fields.getSelectedMembers('dev')?.first();
    return { devId: user.id, name: cleanName(interaction.fields.getTextInputValue('name')) || cleanName(await nameFor(user, member)) };
  };
  if (action === 'remove') {
    await resolve(interaction, hold({ action: 'remove', by: by(interaction) }), issue);
  } else if (action === 'give') {
    const dev = await pickedDev();
    if (!dev.devId) { await interaction.editReply('❌ Pick the dev.'); return true; }
    await resolve(interaction, hold({ action: 'give', ...dev, by: by(interaction) }), issue);
  } else if (action === 'send') {
    const files = [...(interaction.fields.getUploadedFiles('files')?.values() || [])].slice(0, 10)
      .map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null }));
    if (!files.length) { await interaction.editReply('❌ Add at least one file.'); return true; }
    await resolve(interaction, hold({ action: 'send', files, note: interaction.fields.getTextInputValue('note').trim(), by: by(interaction), ...await pickedDev() }), issue);
  }
  return true;
}

module.exports = {
  getCommandDefinitions, handleContextMenu, handleModal, handleSelect, handleCommand, handleButton,
  // for linear-status.js
  enabled: () => !!KEY, devDirectory, startedIssues, nameOnTitle, namesOf,
};
