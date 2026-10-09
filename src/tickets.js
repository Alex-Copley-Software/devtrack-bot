// tickets.js
// Bug reports filed as Ticket Tool tickets. Ticket Tool makes a text channel
// (test-game-0001 / live-game-0001) under "Test Game Reports" or "Live Game
// Reports"; this file turns what the opener writes there into a DevTrack
// report, keeps the conversation logged, and closes the ticket once the
// report is finished:
//
//   $delete     (Ticket Tool deletes the ticket and saves its transcript)
//
// Ticket Tool may not act on commands sent by another bot. If the ticket is
// still there afterwards, DevTrack saves its own transcript to the same
// transcripts channel and deletes the channel itself. The conversation is
// read before $delete is sent, so if Ticket Tool deletes the ticket without
// posting a transcript, DevTrack posts one from what it read. A ticket never
// goes without a transcript.

const axios = require('axios');
const { AttachmentBuilder, ChannelType, EmbedBuilder, OverwriteType } = require('discord.js');
const { handleNewPost } = require('./handler');
const { logMessage, getAttachments } = require('./message-logger');
const reportPause = require('./report-pause');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';

const ENABLED = process.env.TICKETS_ENABLED !== 'false';
const SETTLE_MS = Number(process.env.TICKET_SETTLE_MS) || 45000;            // wait for the rest of the opener's first messages
const CLOSE_DELAY_MS = process.env.TICKET_CLOSE_DELAY_MS !== undefined ? Number(process.env.TICKET_CLOSE_DELAY_MS) : 5 * 60000;
const CLOSE_ON = process.env.TICKET_CLOSE_ON || 'resolved,declined';
const AUTO_CLOSE = process.env.TICKET_AUTO_CLOSE !== 'false';
const USE_TOOL_COMMANDS = process.env.TICKET_TOOL_COMMANDS !== 'false';
const FALLBACK_CLOSE = process.env.TICKET_FALLBACK_CLOSE !== 'false';
const PREFIX = process.env.TICKET_TOOL_PREFIX || '$';
// Ticket Tool commands sent to finish a ticket, in order. The last one is expected to remove the channel.
const TOOL_SEQUENCE = String(process.env.TICKET_TOOL_SEQUENCE || 'delete').split(',').map(s => s.trim().replace(/^\$/, '')).filter(Boolean);
const STEP_MS = Number(process.env.TICKET_STEP_MS) || 2500;               // how often a close step is checked
const idList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_CATEGORY_IDS = { test: idList(process.env.TICKET_TEST_CATEGORY_ID), live: idList(process.env.TICKET_LIVE_CATEGORY_ID) };
const TRANSCRIPT_CHANNEL_IDS = { test: process.env.TICKET_TEST_TRANSCRIPTS_CHANNEL_ID, live: process.env.TICKET_LIVE_TRANSCRIPTS_CHANNEL_ID };

const KINDS = {
  test: { category: 'testgamereports', transcripts: 'testgametranscripts', label: 'Test game' },
  live: { category: 'livegamereports', transcripts: 'livegametranscripts', label: 'Live game' },
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (method, path, data) => axios({
  method, url: `${API_URL}/api/bot${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout: 15000,
}).then(r => r.data);

let client = null;
let threadReportMap = null;
const known = new Map();          // channelId -> { kind, number, name, reportId }
const settling = new Map();       // channelId -> timer, while waiting for the opener to finish their first messages
const inFlight = new Set();
const pausedNoticed = new Set();
const closing = new Map();        // channelId -> { kind, number, at, transcript }, while a close is running
const missCache = new Map();      // channelId -> time we last found no report for it

// ── what is a ticket ──────────────────────────────────────────────────────────

// { kind, number, name } for a ticket channel, else null. The name and the
// category must both match, so a stray channel called test-game-1 elsewhere
// is ignored.
function ticketInfo(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  const m = /^(test|live)-game-(\d+)/i.exec(channel.name || '');
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const inCategory = norm(channel.parent?.name).includes(KINDS[kind].category) || EXTRA_CATEGORY_IDS[kind].includes(channel.parentId);
  return inCategory ? { kind, number: m[2], name: channel.name } : null;
}

const infoFor = channel => known.get(channel?.id) || ticketInfo(channel);

// 'bug' inside a ticket, the watched channel's type inside a forum thread, else null.
function reportTypeFor(channel, WATCHED_CHANNELS) {
  if (!channel) return null;
  if (ENABLED && infoFor(channel)) return 'bug';
  if (channel.isThread?.()) return WATCHED_CHANNELS[channel.parentId] || null;
  return null;
}

function track(channel, info, reportId) {
  known.set(channel.id, { ...info, reportId });
  threadReportMap?.set(channel.id, reportId);
  missCache.delete(channel.id);
}

async function lookupReport(channelId) {
  try {
    return (await api('get', `/report-by-thread/${channelId}`)).reportId || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// ── reading a ticket ──────────────────────────────────────────────────────────

async function fetchMessages(channel, max = 2000) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    all.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Who opened the ticket. Ticket Tool creates the channel itself, so it is
// read from its welcome message (which mentions the opener), then from the
// one member the channel was opened up to.
async function findOpener(channel, messages) {
  const me = channel.client.user.id;
  for (const m of messages.filter(m => m.author.bot && m.author.id !== me).slice(0, 5)) {
    const user = [...m.mentions.users.values()].find(u => !u.bot);
    if (user) return user;
  }
  const members = [];
  for (const o of channel.permissionOverwrites.cache.values()) {
    if (o.type !== OverwriteType.Member) continue;
    const user = await channel.client.users.fetch(o.id).catch(() => null);
    if (user && !user.bot) members.push(user);
  }
  return members.length === 1 ? members[0] : null;
}

// Answers to a Ticket Tool form, which it posts as an embed when the ticket opens.
// Returns { text, first }: everything for the description, and the first answer for the title.
function formText(messages, me) {
  const parts = [];
  let first = '';
  for (const m of messages.filter(m => m.author.bot && m.author.id !== me).slice(0, 5)) {
    for (const e of m.embeds) {
      if (e.fields?.length) {
        parts.push(e.fields.map(f => `**${f.name}**\n${f.value}`).join('\n\n'));
        first = first || e.fields[0].value;
      } else if (e.description?.includes('```')) {
        parts.push(e.description);
        first = first || (/```(?:\w*\n)?([\s\S]*?)```/.exec(e.description)?.[1] || '');
      }
    }
  }
  return { text: parts.join('\n\n').trim(), first };
}

function titleFrom(text, fallback) {
  const line = String(text || '').replace(/```/g, '\n').split('\n')
    .map(l => l.replace(/[*_`>#~|]/g, '').replace(/\s+/g, ' ').trim())
    .find(l => l.length >= 3 && !/^https?:\/\/\S+$/.test(l));
  if (!line) return fallback;
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function attachmentList(messages) {
  return messages.flatMap(m => [...m.attachments.values()]).slice(0, 10).map(att => ({
    url: att.url, filename: att.name, contentType: att.contentType || 'application/octet-stream', size: att.size || 0,
  }));
}

// ── intake ────────────────────────────────────────────────────────────────────

// Makes the report for a ticket from what its opener has written so far.
// Returns the report id, or null when there is nothing to report yet.
async function intake(channel) {
  const info = infoFor(channel);
  if (!info || inFlight.has(channel.id)) return null;
  inFlight.add(channel.id);
  try {
    const existing = await lookupReport(channel.id);
    if (existing) { await adopt(channel, info, existing); return existing; }

    const messages = await fetchMessages(channel, 200);
    const me = channel.client.user.id;
    const humans = messages.filter(m => !m.author.bot);
    const opener = await findOpener(channel, messages) || humans[0]?.author || null;
    if (!opener) return null;
    const mine = humans.filter(m => m.author.id === opener.id);
    const { text: form, first: formFirst } = formText(messages, me);
    if (!mine.length && !form) return null;                // opened, nothing written yet

    const body = mine.map(m => m.content).filter(Boolean).join('\n\n');
    const description = [form, body].filter(Boolean).join('\n\n') || '(No description provided)';
    // With only a form and no message yet, the ticket itself stands in for the opener's first message.
    const starterMessage = mine[0] || {
      id: channel.id, content: description, author: opener, attachments: new Map(),
    };

    const reportId = await handleNewPost({
      thread: channel, starterMessage, reportType: 'bug', client,
      overrides: {
        title: titleFrom(body || formFirst, `${KINDS[info.kind].label} report ${info.number}`),
        description,
        channelLabel: `#${info.name}`,
        attachments: attachmentList(mine),
        tags: [`${info.kind}-game`],
        receipt: `> 🐛 **Bug report received** (${info.name}). Thank you for reporting, the engineers will get to this shortly.\n> Anything else you post in this ticket is added to the report. React with ✅ below to get pinged when there's an update.`,
      },
    });
    if (!reportId) return null;

    await adopt(channel, info, reportId, opener.id);
    // The first message is logged with the report; the rest of what they wrote while it settled follows.
    for (const m of mine.slice(1)) await logReply(reportId, m);
    console.log(`[Tickets] ${info.name} -> report ${reportId} (opened by ${opener.tag})`);
    return reportId;
  } catch (err) {
    console.error(`[Tickets] Could not log ${info.name}:`, err.response?.data || err.message);
    return null;
  } finally {
    inFlight.delete(channel.id);
  }
}

async function adopt(channel, info, reportId, openerId) {
  track(channel, info, reportId);
  await api('post', '/ticket', { reportId, channelId: channel.id, kind: info.kind, number: info.number, name: info.name, openerId })
    .catch(err => console.error(`[Tickets] Could not register ${info.name}:`, err.response?.data?.error || err.message));
}

const logReply = (reportId, message) => logMessage({
  reportId,
  content: message.content || '(attachment only)',
  authorName: message.author.tag,
  authorId: message.author.id,
  authorAvatar: message.author.displayAvatarURL() || null,
  attachments: getAttachments(message),
  isBot: false,
});

async function pausedNotice(channel, message) {
  if (pausedNoticed.has(channel.id)) return;
  pausedNoticed.add(channel.id);
  await channel.send([
    `<@${message.author.id}> ⏸️ **Bug reports are paused right now.**`,
    `> This ticket was **not** logged in DevTrack. You'll be pinged here once reports are back open.`,
    `> When they are, post here again or open a new ticket, and check the change logs first to confirm this is still a bug and not intended behavior.`,
  ].join('\n')).catch(() => {});
  await reportPause.registerPausedAttempt({
    threadId: channel.id, channelId: channel.parentId, discordUserId: message.author.id,
    discordUser: message.author.tag, title: channel.name,
  });
}

// A person wrote in a channel. Returns true when it was a ticket (handled here).
async function onMessage(message) {
  if (!ENABLED) return false;
  const channel = message.channel;
  const info = infoFor(channel);
  if (!info) return false;

  let reportId = known.get(channel.id)?.reportId;
  if (!reportId && Date.now() - (missCache.get(channel.id) || 0) > 60000) {
    // After a restart the ticket may already have a report.
    reportId = await lookupReport(channel.id).catch(() => null);
    if (reportId) await adopt(channel, info, reportId);
    else missCache.set(channel.id, Date.now());
  }
  if (reportId) { await logReply(reportId, message); return true; }

  if (reportPause.isPaused()) { await pausedNotice(channel, message); return true; }
  if (!settling.has(channel.id) && !inFlight.has(channel.id)) {
    settling.set(channel.id, setTimeout(() => {
      settling.delete(channel.id);
      intake(channel);
    }, SETTLE_MS));
  }
  return true;
}

// A ticket opened with a form may never get a typed message: look once it has settled.
function onChannelCreate(channel) {
  if (!ENABLED || !ticketInfo(channel)) return;
  setTimeout(() => {
    if (!known.has(channel.id) && !settling.has(channel.id) && !reportPause.isPaused()) intake(channel);
  }, SETTLE_MS + 15000);
}

async function onChannelDelete(channel) {
  const info = known.get(channel.id);
  clearTimeout(settling.get(channel.id));
  settling.delete(channel.id);
  if (!info) return;
  known.delete(channel.id);
  threadReportMap?.delete(channel.id);
  if (closing.has(channel.id)) return;                     // our own close reports itself
  await api('post', `/tickets/${channel.id}/closed`, { method: 'manual' }).catch(() => {});
  console.log(`[Tickets] ${info.name} was deleted in Discord`);
}

// Tickets that were open before the bot started (or that it missed).
async function sweep() {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      const info = ticketInfo(channel);
      if (!info || known.has(channel.id) || settling.has(channel.id)) continue;
      try {
        const reportId = await lookupReport(channel.id);
        if (reportId) await adopt(channel, info, reportId);
        else if (!reportPause.isPaused()) await intake(channel);
      } catch (err) {
        console.error(`[Tickets] Sweep failed for ${info.name}:`, err.message);
      }
      await sleep(300);
    }
  }
}

// ── transcripts ───────────────────────────────────────────────────────────────

function transcriptsChannel(guild, kind) {
  const byId = TRANSCRIPT_CHANNEL_IDS[kind] && guild.channels.cache.get(TRANSCRIPT_CHANNEL_IDS[kind]);
  if (byId) return byId;
  return guild.channels.cache.find(c => c.isTextBased?.() && !c.isThread?.() && norm(c.name).includes(KINDS[kind].transcripts)) || null;
}

function transcriptKind(channel) {
  for (const kind of Object.keys(KINDS)) {
    if (channel.id === TRANSCRIPT_CHANNEL_IDS[kind] || norm(channel.name).includes(KINDS[kind].transcripts)) return kind;
  }
  return null;
}

// Another bot (Ticket Tool) posted in a transcripts channel: link it to the report.
async function onBotMessage(message) {
  if (!ENABLED || !client || message.author.id === client.user.id) return;
  const kind = transcriptKind(message.channel);
  if (!kind) return;

  const text = [
    message.content,
    ...message.embeds.flatMap(e => [e.title, e.description, e.footer?.text, e.author?.name, ...(e.fields || []).flatMap(f => [f.name, f.value])]),
    ...[...message.attachments.values()].map(a => a.name),
  ].filter(Boolean).join('\n');

  // The ticket number: in the ticket's name wherever it is quoted, else the one ticket of this kind being closed right now.
  const named = new RegExp(`${kind}-game-(\\d+)`, 'i').exec(text) || /(?:closed|ticket|transcript)[-_ #]*(\d{1,7})\b/i.exec(text);
  const running = [...closing.entries()].filter(([, c]) => c.kind === kind && Date.now() - c.at < 5 * 60000);
  const match = named ? running.find(([, c]) => Number(c.number) === Number(named[1])) : (running.length === 1 ? running[0] : null);
  if (!named && !match) return;

  const fileUrl = [...message.attachments.values()][0]?.url
    || /https?:\/\/\S*transcript\S*/i.exec(text)?.[0]?.replace(/[)\]>]+$/, '') || null;
  try {
    await api('post', '/tickets/transcript', { channelId: match?.[0], kind, number: named?.[1] ?? match?.[1].number, url: message.url, fileUrl });
    if (match) match[1].transcript = message.url;
    console.log(`[Tickets] Transcript linked for ${kind}-game-${named?.[1] ?? match?.[1].number}`);
  } catch (err) {
    if (err.response?.status !== 404) console.error('[Tickets] Could not link a transcript:', err.response?.data?.error || err.message);
  }
}

// DevTrack's own transcript, for when Ticket Tool did not make one.
async function saveOwnTranscript(guild, channelId, ticket, messages) {
  const target = transcriptsChannel(guild, ticket.kind);
  if (!target) throw new Error(`No ${ticket.kind}-game-transcripts channel found`);
  const lines = messages.map(m => {
    const extras = [
      ...[...m.attachments.values()].map(a => `[file] ${a.url}`),
      ...m.embeds.map(e => `[embed] ${[e.title, e.description].filter(Boolean).join(': ')}`.slice(0, 1500)),
    ];
    return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}${m.author.bot ? ' (bot)' : ''}: ${[m.content, ...extras].filter(Boolean).join('\n    ')}`;
  });
  const header = [
    `Ticket:  ${ticket.name}`,
    `Report:  ${ticket.title || ''} (${DASHBOARD_URL}#report/${ticket.reportId})`,
    `Owner:   ${ticket.discordUser || 'unknown'} (${ticket.discordUserId || ticket.openerId || 'unknown'})`,
    `Outcome: ${ticket.status}`,
    `Saved:   ${new Date().toISOString()} by DevTrack, ${messages.length} messages`,
    '',
  ];
  const file = new AttachmentBuilder(Buffer.from([...header, ...lines].join('\n'), 'utf8'), { name: `transcript-${ticket.name}.txt` });
  const embed = new EmbedBuilder()
    .setTitle(`Transcript: ${ticket.name}`)
    .setColor(ticket.status === 'declined' ? 0xf87171 : 0x34d399)
    .addFields(
      { name: 'Ticket Owner', value: ticket.discordUserId ? `<@${ticket.discordUserId}>` : (ticket.discordUser || 'Unknown'), inline: true },
      { name: 'Ticket Name', value: ticket.name, inline: true },
      { name: 'Outcome', value: ticket.status, inline: true },
      { name: 'Report', value: `[${String(ticket.title || 'Open in DevTrack').slice(0, 200)}](${DASHBOARD_URL}#report/${ticket.reportId})` },
    )
    .setFooter({ text: 'Saved by DevTrack' })
    .setTimestamp(new Date());
  const sent = await target.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } });
  await api('post', '/tickets/transcript', { channelId, kind: ticket.kind, number: ticket.number, url: sent.url, fileUrl: sent.attachments.first()?.url || null });
  return sent.url;
}

// ── closing ───────────────────────────────────────────────────────────────────

async function stillExists(channelId) {
  try {
    return await client.channels.fetch(channelId, { force: true });
  } catch (err) {
    if (err.code === 10003 || err.status === 404) return null;
    throw err;
  }
}

async function waitFor(check, steps) {
  const everyMs = STEP_MS;
  const until = Date.now() + steps * STEP_MS;
  while (Date.now() < until) {
    await sleep(everyMs);
    if (await check()) return true;
  }
  return false;
}

// Sends one Ticket Tool command and reports whether anything answered: a
// message from another bot, a rename, a move, or the channel going away.
async function toolCommand(channel, command, steps) {
  const before = { name: channel.name, parentId: channel.parentId };
  const sent = await channel.send(`${PREFIX}${command}`);
  return waitFor(async () => {
    const now = await stillExists(channel.id);
    if (!now) return true;
    if (now.name !== before.name || now.parentId !== before.parentId) return true;
    const after = await now.messages.fetch({ after: sent.id, limit: 10 }).catch(() => null);
    return !!after?.some(m => m.author.bot && m.author.id !== client.user.id);
  }, steps);
}

async function closeTicket(ticket) {
  const channelId = ticket.channelId;
  if (closing.has(channelId)) return;
  let channel = await stillExists(channelId);
  if (!channel) {
    await api('post', `/tickets/${channelId}/closed`, { method: 'already_deleted' });
    known.delete(channelId);
    return;
  }

  const state = { kind: ticket.kind, number: ticket.number, at: Date.now(), transcript: ticket.transcriptUrl || null };
  closing.set(channelId, state);
  try {
    await channel.send(`🔒 **This ticket is now being deleted.** The report is ${ticket.status} and a transcript is being saved.`).catch(() => {});

    // Read now: once the channel is deleted there is nothing left to read.
    const guild = channel.guild;
    const snapshot = await fetchMessages(channel);

    if (USE_TOOL_COMMANDS && TOOL_SEQUENCE.length) {
      for (const [i, command] of TOOL_SEQUENCE.entries()) {
        if (!(await stillExists(channelId))) break;
        const answered = await toolCommand(channel, command, 6);
        if (!answered && i < TOOL_SEQUENCE.length - 1) break;   // ignored: no point sending the rest
      }
      if (await waitFor(async () => !(await stillExists(channelId)), 18)) {
        // Ticket Tool posts its transcript as it deletes. If none turns up, ours goes in its place.
        await waitFor(async () => !!state.transcript, 8);
        if (!state.transcript) {
          state.transcript = await saveOwnTranscript(guild, channelId, ticket, snapshot)
            .catch(err => { console.error(`[Tickets] ${ticket.name} was deleted with no transcript, and saving one failed:`, err.message); return null; });
        }
        await api('post', `/tickets/${channelId}/closed`, { method: 'ticket_tool' });
        known.delete(channelId);
        console.log(`[Tickets] ${ticket.name} deleted by Ticket Tool (transcript ${state.transcript})`);
        return;
      }
      console.warn(`[Tickets] Ticket Tool did not delete ${ticket.name}`);
    }

    if (!FALLBACK_CLOSE) throw new Error('Ticket Tool did not act on the delete command');
    channel = await stillExists(channelId);
    if (channel) {
      if (!state.transcript) state.transcript = await saveOwnTranscript(guild, channelId, ticket, await fetchMessages(channel));
      await channel.delete(`DevTrack: report ${ticket.status}, transcript saved`);
    }
    await api('post', `/tickets/${channelId}/closed`, { method: 'devtrack' });
    known.delete(channelId);
    console.log(`[Tickets] ${ticket.name} closed by DevTrack (transcript ${state.transcript})`);
  } catch (err) {
    const reason = err.response?.data?.error || err.message;
    console.error(`[Tickets] Could not close ${ticket.name}:`, reason);
    const result = await api('post', `/tickets/${channelId}/close-failed`, { error: reason }).catch(() => null);
    if (result?.ticket?.gaveUp) {
      const still = await stillExists(channelId).catch(() => null);
      await still?.send(`⚠️ DevTrack could not close this ticket automatically (${reason}). It needs closing by hand.`).catch(() => {});
    }
  } finally {
    // Kept briefly so a transcript that arrives late is still matched to this ticket.
    setTimeout(() => closing.delete(channelId), 60000);
  }
}

async function closeFinished() {
  if (!AUTO_CLOSE) return;
  try {
    const { tickets } = await api('get', `/tickets/pending-close?delayMs=${CLOSE_DELAY_MS}&statuses=${encodeURIComponent(CLOSE_ON)}`);
    for (const ticket of tickets) await closeTicket(ticket);
  } catch (err) {
    console.error('[Tickets] Close check failed:', err.response?.data?.error || err.message);
  }
}

// ── start ─────────────────────────────────────────────────────────────────────

function start(c, map) {
  if (!ENABLED) return;
  client = c;
  threadReportMap = map;
  console.log(`[Tickets] Watching Ticket Tool tickets (close on ${CLOSE_ON} after ${Math.round(CLOSE_DELAY_MS / 1000)}s, auto close ${AUTO_CLOSE ? 'on' : 'off'}, commands: ${USE_TOOL_COMMANDS ? TOOL_SEQUENCE.map(c => PREFIX + c).join(' ') : 'none'})`);
  sweep().catch(err => console.error('[Tickets] Startup sweep failed:', err.message));
  setInterval(() => sweep().catch(err => console.error('[Tickets] Sweep failed:', err.message)), 10 * 60000);
  setInterval(closeFinished, 60000);
}

module.exports = {
  start, onMessage, onBotMessage, onChannelCreate, onChannelDelete, reportTypeFor, intake, infoFor,
  ticketInfo, titleFrom, formText, findOpener, _closeFinished: closeFinished,
};
