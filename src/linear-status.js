// linear-status.js
// Shows each dev's availability on their forum (or forum post) by prefixing its name:
//
//   🟢  has a task in progress in Linear (an In Progress issue with their name on the end)
//   🟡  nothing in progress, ready to be tasked
//
// Linear decides who is busy; the asset roster (GET /api/bot/assets/dev-status)
// says who each dev is and where their dot goes: the "Status post" on their
// roster entry (a forum channel or one post). A dev with none set falls back to
// a post whose title starts with their name, in the forums the asset roster
// lists. Dots the bot left anywhere else are taken off again.
//
// Runs every two minutes, and a few seconds after a task is given, taken off or
// finished from Discord. Needs LINEAR_API_KEY and ASSET_STATUS_POSTS=true, and
// Manage Channels (forums) or Manage Threads (posts) where the dots go.
// ASSET_STATUS_POSTS_DRY_RUN=true logs the renames instead of making them.

const axios = require('axios');
const { ChannelType } = require('discord.js');
const linear = require('./linear');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const ENABLED = String(process.env.ASSET_STATUS_POSTS || '').toLowerCase() === 'true';
const DRY_RUN = String(process.env.ASSET_STATUS_POSTS_DRY_RUN || '').toLowerCase() === 'true';

const SYNC_MS = 2 * 60 * 1000;
const TASKED = '🟢';
const FREE = '🟡';
const PREFIX = /^(?:\s*(?:🟢|🟡))+\s*/u;

// Discord allows two renames per channel every ten minutes; a third would
// queue and stall the whole sync, so the bot keeps count itself.
const RENAME_WINDOW_MS = 10 * 60 * 1000;
const renames = new Map(); // channelId -> [timestamps]
const complained = new Set();
let lastSummary = '';
let client = null;
let running = false;
let soon = null;

const base = name => String(name || '').replace(PREFIX, '');

// "Ruku Chat (Mesh & Texture)" belongs to Ruku; "Rukus corner" does not.
function titleMatches(title, devName) {
  const t = base(title).toLowerCase();
  const n = String(devName || '').trim().toLowerCase();
  if (n.length < 2 || !t.startsWith(n)) return false;
  const next = t[n.length];
  return next === undefined || !/[\p{L}\p{N}]/u.test(next);
}

// The forums the dev's fallback posts can be in: the ones the roster's settings list.
async function fallbackForumIds() {
  const config = await axios.get(`${API_URL}/api/bot/assets/agent/config`, { headers: { 'x-bot-secret': BOT_SECRET }, timeout: 10000 })
    .then(r => r.data).catch(() => null);
  return config?.enabled ? [...(config.channelIds || []), ...(config.teamCategoryIds || [])] : [];
}

async function forumsUnder(ids) {
  const forums = new Map();
  for (const id of ids) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel) continue;
    if (channel.type === ChannelType.GuildForum) forums.set(channel.id, channel);
    else if (channel.type === ChannelType.GuildCategory) {
      for (const child of channel.children.cache.values()) if (child.type === ChannelType.GuildForum) forums.set(child.id, child);
    }
  }
  return [...forums.values()];
}

const dotOf = name => (String(name || '').match(/^\s*(🟢|🟡)/u) || [])[1] || '';

// dot: TASKED, FREE, or '' to take a dot off. Compared by dot, not by the
// whole name, because Discord rewrites some channel names (spaces to dashes).
async function rename(channel, dot) {
  if (dotOf(channel.name) === dot) return 'same';
  const wanted = `${dot ? `${dot} ` : ''}${base(channel.name)}`.slice(0, 100);
  const now = Date.now();
  const recent = (renames.get(channel.id) || []).filter(t => now - t < RENAME_WINDOW_MS);
  if (recent.length >= 2) return 'waiting'; // picked up on a later sync
  if (DRY_RUN) { console.log(`[LinearStatus] (dry run) "${channel.name}" -> "${wanted}"`); return 'dry'; }
  try {
    const before = channel.name;
    await channel.setName(wanted, 'Linear: dev availability');
    renames.set(channel.id, [...recent, now]);
    console.log(`[LinearStatus] "${before}" -> "${wanted}"`);
    return 'renamed';
  } catch (err) {
    if (!complained.has(channel.id)) {
      complained.add(channel.id);
      console.error(`[LinearStatus] Could not rename "${channel.name}" (${channel.id}): ${err.message}. The bot needs Manage Channels (forums) or Manage Threads (posts) there.`);
    }
    return 'failed';
  }
}

async function sync() {
  const dir = await linear.devDirectory(true);
  if (!dir.roster.length) return; // the roster isn't reachable: leave the dots as they are
  const started = await linear.startedIssues();
  const devs = dir.roster.map(d => {
    const names = new Set(linear.namesOf(dir, d.discordUserId, [d.name]));
    return { ...d, busy: started.filter(i => linear.nameOnTitle(i.title, names)).length };
  });

  const pinned = new Set(devs.map(d => d.discordThreadId).filter(Boolean));
  const forums = await forumsUnder([...await fallbackForumIds(), ...pinned]);
  const posts = [];
  for (const forum of forums) {
    const active = await forum.threads?.fetchActive().catch(() => null);
    if (active) posts.push(...active.threads.values());
  }

  const matched = [];
  const unmatched = [];
  // Longest names first, so "Rabbit3D" claims its post before a shorter name could.
  const claimed = new Set();
  for (const dev of [...devs].sort((a, b) => b.name.length - a.name.length)) {
    let mine = [];
    if (dev.discordThreadId) {
      const target = await client.channels.fetch(dev.discordThreadId).catch(() => null);
      if (target && typeof target.setName === 'function' && !target.archived) mine = [target];
    } else {
      mine = posts.filter(p => !claimed.has(p.id) && titleMatches(p.name, dev.name));
    }
    if (!mine.length) { unmatched.push(dev.name); continue; }
    for (const channel of mine) {
      claimed.add(channel.id);
      await rename(channel, dev.busy ? TASKED : FREE);
      matched.push(`${dev.name}${dev.busy ? ` (${dev.busy})` : ''}`);
    }
  }

  // Take the dot off posts and forums that are no longer anyone's status place.
  let cleared = 0;
  for (const stale of [...posts, ...forums]) {
    if (!claimed.has(stale.id) && dotOf(stale.name) && await rename(stale, '') === 'renamed') cleared++;
  }

  const text = `${matched.length} status place(s), ${devs.filter(d => d.busy).length} dev(s) with work in progress; ${cleared} old dot(s) removed; no place for: ${unmatched.sort().join(', ') || 'nobody'}`;
  if (text !== lastSummary) { console.log(`[LinearStatus] ${text}`); lastSummary = text; }
}

async function run() {
  if (running) { refreshSoon(); return; }
  running = true;
  try { await sync(); } catch (err) {
    console.error('[LinearStatus] Sync failed:', err.response?.data?.error || err.message);
  } finally { running = false; }
}

// After a change from Discord: look again in a few seconds, once.
function refreshSoon() {
  if (!client || !ENABLED || !linear.enabled()) return;
  clearTimeout(soon);
  soon = setTimeout(run, 5000);
}

function start(discordClient) {
  if (!ENABLED || !linear.enabled()) return;
  client = discordClient;
  console.log(`[LinearStatus] Dots follow Linear's In Progress${DRY_RUN ? ' (dry run: nothing is renamed)' : ''}`);
  setTimeout(run, 15 * 1000);
  setInterval(run, SYNC_MS);
}

module.exports = { start, refreshSoon, titleMatches };
