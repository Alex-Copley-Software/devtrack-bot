// linear.js
// Right-click a message → Apps → "Send to Linear": its attached files go onto
// an issue in the Linear "Assets" team, as a comment with the files and a link
// back to the message, and the issue moves to Done.
//
//   right-click → Send to Linear → type the issue (ASS-12, or words from its title)
//     -> one match: sent straight away
//     -> several: pick one from a list
//
// Who can use it: server admins in a server the bot is in, and the owner
// anywhere (DMs and group chats too, through User Install). Off unless
// LINEAR_API_KEY is set. LINEAR_TEAM picks the team (default "Assets").

const axios = require('axios');
const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder,
} = require('discord.js');

const KEY = process.env.LINEAR_API_KEY;
const TEAM = process.env.LINEAR_TEAM || 'Assets';
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const COMMAND = 'Send to Linear';
const MODAL = 'linear-send';
const PICK = 'linear-pick';
// integration_types 0 and 1: installed to a server or to a user's account.
// contexts 0, 1, 2: usable in servers, in the bot's own DM, and in other DMs and group chats.
const ANYWHERE = { integration_types: [0, 1], contexts: [0, 1, 2] };

// The right-clicked message's files and link, kept until the form (and, if needed, the pick) is done.
const pending = new Map();

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

// "AST-12" or "12" is that issue; anything else searches the open issues' titles.
async function findIssues(text) {
  const t = await assetsTeam();
  const q = text.trim();
  const id = /^([a-z]+)-(\d+)$/i.exec(q) || (/^\d+$/.test(q) ? [null, t.key, q] : null);
  if (id) {
    const data = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id: `${id[1].toUpperCase()}-${id[2]}` }).catch(() => null);
    const issue = data?.issue;
    return issue && issue.team.id === t.id ? [issue] : [];
  }
  // Every word has to be in the title or the parent's title: "doumo aura" is the Aura under Doumo.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const filter = {
    team: { id: { eq: t.id } }, state: { type: { nin: ['completed', 'canceled'] } },
    and: words.map(w => ({ or: [{ title: { containsIgnoreCase: w } }, { parent: { title: { containsIgnoreCase: w } } }] })),
  };
  const { issues } = await gql(`query($filter: IssueFilter!) { issues(first: 25, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE} } } }`, { filter });
  return issues.nodes;
}

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
  const body = [
    `**Delivered** by ${job.by} in Discord: [message](${job.link})`,
    job.note ? `\n${job.note}` : '',
    '', ...lines,
  ].join('\n');
  await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId: issue.id, body } });
  let moved = false;
  if (t.done && issue.state?.type !== 'completed') {
    await gql(`mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`, { id: issue.id, state: t.done.id });
    moved = true;
  }
  return { count: uploaded.length, moved, done: t.done?.name };
}

// ── Discord ──────────────────────────────────────────────────────────────────

function getCommandDefinitions() {
  if (!KEY) return [];
  // Hidden from non-admins in servers; the handlers check again.
  return [{
    ...new ContextMenuCommandBuilder().setName(COMMAND).setType(ApplicationCommandType.Message)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    ...ANYWHERE,
  }];
}

// Server admins in a server the bot is in; the owner anywhere.
const allowed = interaction => interaction.user.id === OWNER
  || (interaction.inCachedGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));

const nope = interaction => interaction.reply({ content: '❌ Only admins can send files to Linear.', flags: MessageFlags.Ephemeral }).then(() => true);

async function handleContextMenu(interaction) {
  if (!KEY || !interaction.isMessageContextMenuCommand() || interaction.commandName !== COMMAND) return false;
  if (!allowed(interaction)) return nope(interaction);
  const message = interaction.targetMessage;
  const files = [...message.attachments.values()].slice(0, 10).map(a => ({ name: a.name, url: a.url, contentType: a.contentType || null }));
  if (!files.length) {
    await interaction.reply({ content: '❌ That message has no files attached.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const key = `${message.channelId}:${message.id}:${interaction.user.id}`;
  pending.set(key, {
    files, by: interaction.user.globalName || interaction.user.username,
    link: `https://discord.com/channels/${interaction.guildId || '@me'}/${message.channelId}/${message.id}`,
    message,
  });
  setTimeout(() => pending.delete(key), 30 * 60 * 1000).unref?.();
  await interaction.showModal(new ModalBuilder().setCustomId(`${MODAL}:${key}`).setTitle('Send to Linear').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('issue').setLabel(`${TEAM} issue: ID or words from the title`)
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder(`${team ? team.key : 'ASS'}-12, or "Byakuya sword"`)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('note').setLabel('Note for the comment (optional)')
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
  ));
  return true;
}

async function finish(interaction, key, issue) {
  const job = pending.get(key);
  if (!job) return interaction.editReply({ content: '❌ That took too long. Right-click the message and try again.', components: [] });
  pending.delete(key);
  await interaction.editReply({ content: `⏳ Sending ${job.files.length} file${job.files.length === 1 ? '' : 's'} to **${issue.identifier}**…`, components: [] });
  try {
    const r = await send(job, issue);
    await interaction.editReply(`✅ Sent ${r.count} file${r.count === 1 ? '' : 's'} to [${issue.identifier}: ${issue.title}](<${issue.url}>)` +
      (r.moved ? ` and moved it to ${r.done}.` : r.done ? ` (it was already ${issue.state.name}).` : '. This team has no Done state, so it was left as it is.'));
    // Only works where the bot is in the channel; elsewhere the reply above is enough.
    await job.message.react('✅').catch(() => {});
  } catch (err) {
    console.error('[Linear] send failed:', err.response?.data || err.message);
    await interaction.editReply(`❌ Could not send to ${issue.identifier}: ${err.message}`);
  }
}

async function handleModal(interaction) {
  if (!interaction.customId?.startsWith(`${MODAL}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const key = interaction.customId.slice(MODAL.length + 1);
  const note = interaction.fields.getTextInputValue('note').trim();
  if (pending.has(key)) pending.get(key).note = note;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let found;
  try { found = await findIssues(interaction.fields.getTextInputValue('issue')); } catch (err) {
    console.error('[Linear] search failed:', err.response?.data || err.message);
    await interaction.editReply(`❌ Could not reach Linear: ${err.message}`);
    return true;
  }
  if (!found.length) {
    await interaction.editReply(`❌ No open issue in the ${TEAM} team matches that. Try its ID (like ${(team && team.key) || 'ASS'}-12).`);
    return true;
  }
  if (found.length === 1) { await finish(interaction, key, found[0]); return true; }
  pending.get(key).choices = new Map(found.map(i => [i.id, i]));
  await interaction.editReply({
    content: `${found.length} issues match. Which one?`,
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${PICK}:${key}`).setPlaceholder('Pick the issue')
      // Many issues share a title ("Aura"), so say what each belongs to.
      .addOptions(found.map(i => ({
        label: `${i.identifier}: ${i.title}`.slice(0, 100), value: i.id,
        description: [i.parent ? `Part of ${i.parent.identifier} ${i.parent.title}` : i.project?.name, i.state?.name].filter(Boolean).join(' · ').slice(0, 100) || undefined,
      }))))],
  });
  return true;
}

async function handleSelect(interaction) {
  if (!interaction.customId?.startsWith(`${PICK}:`)) return false;
  if (!allowed(interaction)) return nope(interaction);
  const key = interaction.customId.slice(PICK.length + 1);
  const issue = pending.get(key)?.choices?.get(interaction.values[0]);
  await interaction.deferUpdate();
  if (!issue) {
    await interaction.editReply({ content: '❌ That took too long. Right-click the message and try again.', components: [] });
    return true;
  }
  await finish(interaction, key, issue);
  return true;
}

module.exports = { getCommandDefinitions, handleContextMenu, handleModal, handleSelect };
