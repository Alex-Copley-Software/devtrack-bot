// dev-status.js
// Shows each dev's availability by putting a dot in front of the name of their
// place on Discord (a category, forum, channel or forum post):
//
//   🟢  has a task in progress on the Assets board
//   🟡  nothing in progress, ready to be tasked
//
// The Assets board on DevTrack decides who is busy, and its Developers tab says
// who each dev is and which place is theirs (backend /api/bot/board/working); a
// dev with no place gets no dot. Dots the bot left on a place that is no longer
// anyone's are taken off again.
//
// After each sync the bot reports back: each dev's dot and any problem with their
// place, plus the server's categories and channels for the page's picker.
//
// Runs every two minutes, and a few seconds after a task is given, taken off or
// finished (from Discord or the page), or a dev is changed. Needs
// ASSET_STATUS_POSTS=true, and Manage Channels (categories, forums, channels) or
// Manage Threads (posts) where the dots go.
// ASSET_STATUS_POSTS_DRY_RUN=true logs the renames instead of making them.

const axios = require('axios');
const { ChannelType } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const ENABLED = String(process.env.ASSET_STATUS_POSTS || '').toLowerCase() === 'true';
const DRY_RUN = String(process.env.ASSET_STATUS_POSTS_DRY_RUN || '').toLowerCase() === 'true';
const bot = { headers: { 'x-bot-secret': BOT_SECRET }, timeout: 10000 };

const SYNC_MS = 2 * 60 * 1000;
const TASKED = '🟢';
const FREE = '🟡';
const PREFIX = /^(?:\s*(?:🟢|🟡))+\s*/u;

// Discord allows two renames per channel every ten minutes; a third would
// queue and stall the whole sync, so the bot keeps count itself.
const RENAME_WINDOW_MS = 10 * 60 * 1000;
const renames = new Map(); // channelId -> [timestamps]
const complained = new Set();
const dotted = new Set(); // posts the bot put a dot on (channels are found by name)
let lastSummary = '';
let lastChannels = '';
let lastStatus = '';
let client = null;
let running = false;
let soon = null;

const base = name => String(name || '').replace(PREFIX, '');
const dotOf = name => (String(name || '').match(/^\s*(🟢|🟡)/u) || [])[1] || '';

// Places a dot can go, for the page's picker.
const PICKABLE = {
  [ChannelType.GuildCategory]: 'category', [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildText]: 'text', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildMedia]: 'media',
};

// dot: TASKED, FREE, or '' to take a dot off. Compared by dot, not by the
// whole name, because Discord rewrites some channel names (spaces to dashes).
async function rename(channel, dot) {
  if (dotOf(channel.name) === dot) return 'same';
  const wanted = `${dot ? `${dot} ` : ''}${base(channel.name)}`.slice(0, 100);
  const now = Date.now();
  const recent = (renames.get(channel.id) || []).filter(t => now - t < RENAME_WINDOW_MS);
  if (recent.length >= 2) return 'waiting'; // picked up on a later sync
  if (DRY_RUN) { console.log(`[DevStatus] (dry run) "${channel.name}" -> "${wanted}"`); return 'dry'; }
  try {
    const before = channel.name;
    await channel.setName(wanted, 'Assets board: dev availability');
    renames.set(channel.id, [...recent, now]);
    console.log(`[DevStatus] "${before}" -> "${wanted}"`);
    return 'renamed';
  } catch (err) {
    if (!complained.has(channel.id)) {
      complained.add(channel.id);
      console.error(`[DevStatus] Could not rename "${channel.name}" (${channel.id}): ${err.message}. The bot needs Manage Channels (categories, forums, channels) or Manage Threads (posts) there.`);
    }
    return 'failed';
  }
}

async function reportChannels() {
  const channels = [];
  for (const guild of client.guilds.cache.values()) {
    for (const c of guild.channels.cache.values()) {
      if (!PICKABLE[c.type]) continue;
      channels.push({ id: c.id, name: base(c.name), type: PICKABLE[c.type], parentId: c.parentId || null, parentName: c.parent ? base(c.parent.name) : null, guildName: guild.name, position: c.rawPosition ?? 0 });
    }
  }
  channels.sort((a, b) => (a.guildName || '').localeCompare(b.guildName || '') || a.position - b.position);
  const text = JSON.stringify(channels);
  if (text === lastChannels) return;
  await axios.put(`${API_URL}/api/bot/devs/channels`, { channels }, bot);
  lastChannels = text;
}

async function sync() {
  let roster;
  try {
    ({ data: { devs: roster } } = await axios.get(`${API_URL}/api/bot/board/working`, bot));
  } catch (err) {
    console.error('[DevStatus] Could not load the devs:', err.response?.data?.error || err.message);
    return; // the list isn't reachable: leave the dots as they are
  }
  await reportChannels().catch(err => console.error('[DevStatus] Could not send the channel list:', err.message));

  const status = {};
  const claimed = new Set();
  const problems = [];
  let busyDevs = 0;
  for (const dev of roster) {
    const tasks = dev.tasks || [];
    if (tasks.length) busyDevs++;
    const entry = { dot: tasks.length ? 'busy' : 'free', place: null, problem: null, tasks: tasks.map(t => ({ identifier: t.identifier, label: t.label })) };
    status[dev.id] = entry;
    if (!dev.channelId) { entry.dot = null; continue; }
    const place = await client.channels.fetch(dev.channelId).catch(() => null);
    if (!place || typeof place.setName !== 'function') { entry.problem = 'The bot can\'t see that channel'; problems.push(dev.name); continue; }
    entry.place = { id: place.id, name: base(place.name) };
    if (place.isThread?.() && place.archived) { entry.problem = 'That post is closed (archived)'; problems.push(dev.name); continue; }
    claimed.add(place.id);
    const result = await rename(place, tasks.length ? TASKED : FREE);
    if (place.isThread?.()) dotted.add(place.id);
    if (result === 'failed') { entry.problem = 'The bot isn\'t allowed to rename it'; problems.push(dev.name); }
    if (result === 'waiting') entry.problem = 'Discord allows two renames per 10 minutes; it will catch up';
  }

  // Take the dot off places that are no longer anyone's.
  let cleared = 0;
  const stale = [];
  for (const guild of client.guilds.cache.values()) {
    for (const c of guild.channels.cache.values()) if (PICKABLE[c.type] && !claimed.has(c.id) && dotOf(c.name)) stale.push(c);
  }
  for (const id of dotted) {
    if (claimed.has(id)) continue;
    const post = await client.channels.fetch(id).catch(() => null);
    if (post && dotOf(post.name)) stale.push(post); else dotted.delete(id);
  }
  for (const c of stale) if (await rename(c, '') === 'renamed') { cleared++; dotted.delete(c.id); }

  const text = JSON.stringify(status);
  if (text !== lastStatus) {
    await axios.put(`${API_URL}/api/bot/devs/status`, { status }, bot).then(() => { lastStatus = text; })
      .catch(err => console.error('[DevStatus] Could not report the dots:', err.message));
  }

  const placed = roster.filter(d => d.channelId).length;
  const summary = `${placed} of ${roster.length} dev(s) have a place, ${busyDevs} with work in progress; ${cleared} old dot(s) removed${problems.length ? `; problems: ${problems.sort().join(', ')}` : ''}`;
  if (summary !== lastSummary) { console.log(`[DevStatus] ${summary}`); lastSummary = summary; }
}

async function run() {
  if (running) { refreshSoon(); return; }
  running = true;
  try { await sync(); } catch (err) {
    console.error('[DevStatus] Sync failed:', err.response?.data?.error || err.message);
  } finally { running = false; }
}

// After a change from Discord or the page: look again in a few seconds, once.
function refreshSoon(ms = 5000) {
  if (!client || !ENABLED) return;
  clearTimeout(soon);
  soon = setTimeout(run, ms);
}

function start(discordClient) {
  if (!ENABLED) return;
  client = discordClient;
  console.log(`[DevStatus] Dots follow the Assets board's In progress${DRY_RUN ? ' (dry run: nothing is renamed)' : ''}`);
  setTimeout(run, 15 * 1000);
  setInterval(run, SYNC_MS);
}

module.exports = { start, refreshSoon };
