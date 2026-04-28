// sync.js
// Scans existing forum threads and adds them to the queue if not already there

const axios = require('axios');
const FormData = require('form-data');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

async function syncChannel(channel, reportType, threadReportMap) {
  console.log(`[Sync] Scanning #${channel.name} (${reportType})...`);

  let added = 0, skipped = 0, failed = 0;

  try {
    const activeThreads = await channel.threads.fetchActive();
    const archivedThreads = await channel.threads.fetchArchived({ limit: 100 });
    const allThreads = [
      ...activeThreads.threads.values(),
      ...archivedThreads.threads.values(),
    ];

    console.log(`[Sync] Found ${allThreads.length} threads in #${channel.name}`);

    for (const thread of allThreads) {
      // Check if already in database via thread ID or message ID BEFORE trying to create
      let existingId = null;
      try {
        const r = await axios.get(`${API_URL}/api/bot/report-by-thread/${thread.id}`, {
          headers: { 'x-bot-secret': BOT_SECRET }, timeout: 5000,
        });
        existingId = r.data?.reportId;
      } catch {}

      // Fallback: check by message ID
      if (!existingId) {
        let starterMsg = null;
        try { starterMsg = await thread.fetchStarterMessage({ cache: false }); } catch {}
        if (starterMsg) {
          try {
            const r = await axios.get(`${API_URL}/api/bot/report-by-message/${starterMsg.id}`, {
              headers: { 'x-bot-secret': BOT_SECRET }, timeout: 5000,
            });
            existingId = r.data?.reportId;
          } catch {}
          // Store starter message for later use
          thread._cachedStarter = starterMsg;
        }
      }

      if (existingId) {
        threadReportMap.set(thread.id, existingId);
        skipped++;
        continue;
      }

      // Use cached starter message from existence check above if available
      let starterMessage = thread._cachedStarter || null;
      if (!starterMessage) {
        try {
          starterMessage = await thread.fetchStarterMessage({ cache: false });
        } catch {
          failed++;
          continue;
        }
      }
      if (!starterMessage) { failed++; continue; }

      const form = new FormData();
      form.append('type', reportType);
      form.append('title', thread.name);
      form.append('description', starterMessage.content || '(No description provided)');
      form.append('priority', 'medium');
      form.append('discordUser', starterMessage.author?.tag || 'unknown');
      form.append('discordUserId', starterMessage.author?.id || '');
      form.append('discordThreadId', thread.id);
      form.append('discordChannel', `#${channel.name}`);
      form.append('discordMessageId', starterMessage.id || thread.id);
      // Suggestions skip the queue
      if (reportType === 'suggestion') {
        form.append('queued', 'false');
        form.append('status', 'open');
      }

      try {
        const response = await axios.post(`${API_URL}/api/bot/report`, form, {
          headers: { ...form.getHeaders(), 'x-bot-secret': BOT_SECRET },
          timeout: 15000,
        });
        threadReportMap.set(thread.id, response.data.reportId);
        added++;
        console.log(`[Sync] Added: "${thread.name}"`);
      } catch (err) {
        if (err.response?.status === 409) {
          skipped++;
        } else {
          console.error(`[Sync] Failed to add "${thread.name}":`, err.response?.data || err.message);
          failed++;
        }
      }

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

  console.log(`[Sync] Complete — Added: ${totalAdded}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
  return { totalAdded, totalSkipped, totalFailed };
}

module.exports = { runSync };