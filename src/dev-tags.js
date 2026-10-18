// dev-tags.js
// Dev-name forum tags (Ricky, Bryan, Vaayu, Yose) that testers put on their
// posts so a report says which dev it is for. The bug queue on the dashboard
// filters and sorts by them.
//
// Every forum has its own tag ids, so a tag counts if its id is listed below
// or its name is one of the dev names. DEV_TAG_NAMES (comma separated)
// replaces the name list.
//
// The tags are sent with a new report, again whenever a post's tags change,
// and for every post in the watched forums when the bot starts (which also
// fills in reports made before this existed).

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

const DEV_TAG_IDS = {
  '1487305828745744384': 'Ricky',
  '1487305859561291939': 'Bryan',
  '1561083002266722334': 'Vaayu',
  '1561090228096077969': 'Yose',
};
const DEV_NAMES = (process.env.DEV_TAG_NAMES || 'Ricky,Bryan,Vaayu,Yose').split(',').map(n => n.trim()).filter(Boolean);
const byName = new Map(DEV_NAMES.map(n => [n.toLowerCase(), n]));

const ARCHIVED_PAGES = 10; // 100 archived posts a page, per forum, at startup
const BATCH = 200;

function devTagsFor(thread) {
  const available = thread?.parent?.availableTags || [];
  const names = (thread?.appliedTags || []).map(id => {
    if (DEV_TAG_IDS[id]) return DEV_TAG_IDS[id];
    const tag = available.find(t => t.id === id);
    return tag ? byName.get(String(tag.name).trim().toLowerCase()) : null;
  }).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function send(items) {
  for (let i = 0; i < items.length; i += BATCH) {
    await axios.post(`${API_URL}/api/bot/dev-tags`, { items: items.slice(i, i + BATCH) }, {
      headers: { 'x-bot-secret': BOT_SECRET }, timeout: 30000,
    });
  }
}

const key = list => list.join(',');

// A watched forum post's tags changed.
async function onThreadUpdate(oldThread, newThread) {
  const before = key([...(oldThread?.appliedTags || [])].sort());
  const after = key([...(newThread?.appliedTags || [])].sort());
  if (before === after) return;
  try {
    await send([{ threadId: newThread.id, devTags: devTagsFor(newThread) }]);
  } catch (err) {
    console.error(`[DevTags] Could not update the tags for ${newThread.id}:`, err.message);
  }
}

// Every post in the watched forums: active ones, and the newest archived ones.
async function syncAll(client, forumIds) {
  const items = [];
  try {
    for (const forumId of forumIds) {
      const forum = await client.channels.fetch(forumId).catch(() => null);
      if (!forum?.threads?.fetchArchived) continue;
      const active = await forum.threads.fetchActive().catch(() => null);
      for (const thread of active?.threads?.values() || []) items.push({ threadId: thread.id, devTags: devTagsFor(thread) });
      let before;
      for (let page = 0; page < ARCHIVED_PAGES; page++) {
        const archived = await forum.threads.fetchArchived({ limit: 100, before }).catch(() => null);
        const threads = [...(archived?.threads?.values() || [])];
        for (const thread of threads) items.push({ threadId: thread.id, devTags: devTagsFor(thread) });
        if (!archived?.hasMore || !threads.length) break;
        before = threads[threads.length - 1];
      }
    }
    await send(items);
    console.log(`[DevTags] Synced the dev tags on ${items.length} forum post(s); ${items.filter(i => i.devTags.length).length} have one`);
  } catch (err) {
    console.error('[DevTags] Startup sync failed:', err.message);
  }
}

module.exports = { devTagsFor, onThreadUpdate, syncAll, DEV_NAMES };
