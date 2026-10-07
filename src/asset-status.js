// asset-status.js
// Shows each dev's availability on their forum post by prefixing its title:
//
//   🟢  has open asset tasks
//   🟡  nothing assigned, ready to be tasked
//
// The tracker decides who is tasked (GET /api/bot/assets/dev-status); the bot
// only renames. A post belongs to a dev when the roster entry names it
// (Status post, on the Team view), or else when the post's title starts with
// the dev's name and it sits in a forum the asset agent reads.
//
// Does nothing unless ASSET_STATUS_POSTS=true. Needs Manage Threads.

const axios = require('axios');
const { ChannelType } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const ENABLED = String(process.env.ASSET_STATUS_POSTS || '').toLowerCase() === 'true';
const DRY_RUN = String(process.env.ASSET_STATUS_POSTS_DRY_RUN || '').toLowerCase() === 'true';

const SYNC_MS = 2 * 60 * 1000;
const TASKED = '🟢';
const FREE = '🟡';
const PREFIX = /^(?:\s*(?:🟢|🟡))+\s*/u;

// Discord allows two renames per thread every ten minutes; a third would
// queue and stall the whole sync, so the bot keeps count itself.
const RENAME_WINDOW_MS = 10 * 60 * 1000;
const renames = new Map(); // threadId -> [timestamps]
const complained = new Set();
let lastSummary = '';
let summary = { matched: [], unmatched: [], at: null };

const api = path => axios.get(`${API_URL}/api/bot/assets${path}`, { headers: { 'x-bot-secret': BOT_SECRET }, timeout: 15000 }).then(r => r.data);
const base = name => String(name || '').replace(PREFIX, '');

// "Ruku Chat (Mesh & Texture)" belongs to Ruku; "Rukus corner" does not.
function titleMatches(title, devName) {
  const t = base(title).toLowerCase();
  const n = String(devName || '').trim().toLowerCase();
  if (n.length < 2 || !t.startsWith(n)) return false;
  const next = t[n.length];
  return next === undefined || !/[\p{L}\p{N}]/u.test(next);
}

async function forumsUnder(client, ids) {
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

async function rename(thread, wanted) {
  if (thread.name === wanted) return 'same';
  const now = Date.now();
  const recent = (renames.get(thread.id) || []).filter(t => now - t < RENAME_WINDOW_MS);
  if (recent.length >= 2) return 'waiting'; // picked up on a later sync
  if (DRY_RUN) { console.log(`[AssetStatus] (dry run) "${thread.name}" -> "${wanted}"`); return 'dry'; }
  try {
    const before = thread.name;
    await thread.setName(wanted, 'Asset tracker availability');
    renames.set(thread.id, [...recent, now]);
    console.log(`[AssetStatus] "${before}" -> "${wanted}"`);
    return 'renamed';
  } catch (err) {
    if (!complained.has(thread.id)) {
      complained.add(thread.id);
      console.error(`[AssetStatus] Could not rename "${thread.name}" (${thread.id}): ${err.message}. The bot needs Manage Threads in that forum.`);
    }
    return 'failed';
  }
}

async function sync(client, allowedIds) {
  const { devs } = await api('/dev-status');
  const forums = await forumsUnder(client, allowedIds());
  const posts = [];
  for (const forum of forums) {
    const active = await forum.threads.fetchActive().catch(() => null);
    if (active) posts.push(...active.threads.values());
  }

  const matched = [];
  const unmatched = [];
  // Longest names first, so "Rabbit3D" claims its post before a shorter name could.
  const claimed = new Set();
  for (const dev of [...devs].sort((a, b) => b.name.length - a.name.length)) {
    let mine = [];
    if (dev.discordThreadId) {
      const thread = await client.channels.fetch(dev.discordThreadId).catch(() => null);
      if (thread?.isThread?.() && !thread.archived) mine = [thread];
    } else {
      mine = posts.filter(p => !claimed.has(p.id) && titleMatches(p.name, dev.name));
    }
    if (!mine.length) { unmatched.push(dev.name); continue; }
    for (const thread of mine) {
      claimed.add(thread.id);
      const wanted = `${dev.available ? FREE : TASKED} ${base(thread.name)}`.slice(0, 100);
      await rename(thread, wanted);
      matched.push(`${dev.name} -> ${base(thread.name)} (${dev.available ? 'free' : `${dev.openTasks} open`})`);
    }
  }

  summary = { matched: matched.sort(), unmatched: unmatched.sort(), at: new Date() };
  const text = `${matched.length} post(s) across ${forums.length} forum(s); no post found for: ${unmatched.join(', ') || 'nobody'}`;
  if (text !== lastSummary) { console.log(`[AssetStatus] ${text}`); lastSummary = text; }
}

function start(client, allowedIds) {
  if (!ENABLED) return;
  console.log(`[AssetStatus] Enabled${DRY_RUN ? ' (dry run: nothing is renamed)' : ''}`);
  const run = () => sync(client, allowedIds).catch(err => {
    if (err.response?.status !== 404) console.error('[AssetStatus] Sync failed:', err.response?.data?.error || err.message);
  });
  setTimeout(run, 20 * 1000); // after the agent has loaded its allowlist
  setInterval(run, SYNC_MS);
}

module.exports = { start, titleMatches, base, describe: () => summary, ENABLED };
