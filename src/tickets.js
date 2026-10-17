// tickets.js
// The Ticket Tool tickets left over from when bug reports were filed that way
// (test-game-0001 / live-game-0001 under "Test Game Reports" or "Live Game
// Reports"). Bug reports are forum posts again, so a new ticket is not
// logged. A ticket that already has a report stays linked to it until it is
// closed: what is said in it is logged, status updates and QA checks are
// posted in it, and it is closed once the report is finished:
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
const { AttachmentBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const { logMessage, getAttachments } = require('./message-logger');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';

const ENABLED = process.env.TICKETS_ENABLED !== 'false';
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

const logReply = (reportId, message) => logMessage({
  reportId,
  content: message.content || '(attachment only)',
  authorName: message.author.tag,
  authorId: message.author.id,
  authorAvatar: message.author.displayAvatarURL() || null,
  attachments: getAttachments(message),
  isBot: false,
});

// A person wrote in a channel. Returns true when it was a ticket with a report (logged here).
async function onMessage(message) {
  if (!ENABLED) return false;
  const channel = message.channel;
  const info = infoFor(channel);
  if (!info) return false;

  let reportId = known.get(channel.id)?.reportId;
  if (!reportId && Date.now() - (missCache.get(channel.id) || 0) > 60000) {
    // After a restart the ticket is not in memory yet.
    reportId = await lookupReport(channel.id).catch(() => null);
    if (reportId) track(channel, info, reportId);
    else missCache.set(channel.id, Date.now());
  }
  if (!reportId) return false;
  await logReply(reportId, message);
  return true;
}

async function onChannelDelete(channel) {
  const info = known.get(channel.id);
  if (!info) return;
  known.delete(channel.id);
  threadReportMap?.delete(channel.id);
  if (closing.has(channel.id)) return;                     // our own close reports itself
  await api('post', `/tickets/${channel.id}/closed`, { method: 'manual' }).catch(() => {});
  console.log(`[Tickets] ${info.name} was deleted in Discord`);
}

// The tickets still open when the bot starts, linked back to their reports.
async function sweep() {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      const info = ticketInfo(channel);
      if (!info || known.has(channel.id)) continue;
      try {
        const reportId = await lookupReport(channel.id);
        if (reportId) track(channel, info, reportId);
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
  console.log(`[Tickets] Watching the remaining Ticket Tool tickets (close on ${CLOSE_ON} after ${Math.round(CLOSE_DELAY_MS / 1000)}s, auto close ${AUTO_CLOSE ? 'on' : 'off'}, commands: ${USE_TOOL_COMMANDS ? TOOL_SEQUENCE.map(c => PREFIX + c).join(' ') : 'none'})`);
  sweep().catch(err => console.error('[Tickets] Startup sweep failed:', err.message));
  setInterval(closeFinished, 60000);
}

module.exports = {
  start, onMessage, onBotMessage, onChannelDelete, reportTypeFor, infoFor, ticketInfo, _closeFinished: closeFinished,
};
