// sync.js
// Scans existing forum threads and adds them to the queue if not already there

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

async function syncChannel(channel, reportType, threadReportMap) {
  console.log(`[Sync] Scanning #${channel.name} for existing threads...`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // Fetch active threads
    const activeThreads = await channel.threads.fetchActive();
    // Fetch archived threads
    const archivedThreads = await channel.threads.fetchArchived({ limit: 100 });

    const allThreads = [
      ...activeThreads.threads.values(),
      ...archivedThreads.threads.values(),
    ];

    console.log(`[Sync] Found ${allThreads.length} threads in #${channel.name}`);

    for (const thread of allThreads) {
      // Skip if already cached
      if (threadReportMap.has(thread.id)) {
        skipped++;
        continue;
      }

      // Try to fetch starter message
      let starterMessage = null;
      try {
        starterMessage = await thread.fetchStarterMessage({ cache: false });
      } catch {
        // Thread might be deleted or inaccessible
        failed++;
        continue;
      }

      if (!starterMessage) { failed++; continue; }

      const title = thread.name;
      const content = starterMessage.content || '';
      const discordUser = starterMessage.author?.tag || 'unknown';
      const discordUserId = starterMessage.author?.id || '';
      const discordThreadId = thread.id;
      const discordMessageId = starterMessage.id || thread.id;
      const channelName = channel.name;

      const { FormData } = require('undici');
      const axios2 = require('axios');
      const FormDataNode = require('form-data');

      const form = new FormDataNode();
      form.append('type', reportType);
      form.append('title', title);
      form.append('description', content || '(No description provided)');
      form.append('priority', 'medium');
      form.append('discordUser', discordUser);
      form.append('discordUserId', discordUserId);
      form.append('discordThreadId', discordThreadId);
      form.append('discordChannel', `#${channelName}`);
      form.append('discordMessageId', discordMessageId);

      try {
        const response = await axios2.post(`${API_URL}/api/bot/report`, form, {
          headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
          timeout: 15000,
        });
        threadReportMap.set(thread.id, response.data.reportId);
        added++;
        console.log(`[Sync] Added: "${title}"`);
      } catch (err) {
        if (err.response?.status === 409) {
          // Already exists — just cache it if we can
          skipped++;
        } else {
          console.error(`[Sync] Failed to add "${title}":`, err.response?.data || err.message);
          failed++;
        }
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    console.error(`[Sync] Error scanning channel:`, err.message);
  }

  return { added, skipped, failed };
}

async function runSync(client, WATCHED_CHANNELS, threadReportMap) {
  console.log('[Sync] Starting full sync...');
  let totalAdded = 0, totalSkipped = 0, totalFailed = 0;

  for (const [channelId, reportType] of Object.entries(WATCHED_CHANNELS)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) continue;
      const result = await syncChannel(channel, reportType, threadReportMap);
      totalAdded += result.added;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
    } catch (err) {
      console.error(`[Sync] Could not fetch channel ${channelId}:`, err.message);
    }
  }

  console.log(`[Sync] Complete — Added: ${totalAdded}, Already existed: ${totalSkipped}, Failed: ${totalFailed}`);
  return { totalAdded, totalSkipped, totalFailed };
}

module.exports = { runSync };