// retry-queue.js
// Persists failed report submissions to disk and retries them automatically.
// Also supports manual retry via a Discord button (1 minute cooldown per thread).

const fs   = require('fs');
const path = require('path');

const QUEUE_FILE    = path.join(__dirname, '../retry-queue.json');
const RETRY_INTERVAL = 5 * 60 * 1000;   // auto-retry every 5 minutes
const MAX_ATTEMPTS   = 10;               // give up after 10 auto-attempts (~50 min)
const BUTTON_COOLDOWN = 60 * 1000;       // 1 minute between manual retries per thread

// ── Persistence ───────────────────────────────────────────────────────────────

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (err) {
    console.error('[RetryQueue] Failed to save queue:', err.message);
  }
}

// In-memory queue, loaded from disk on startup
let queue = loadQueue();

// Track last manual retry time per threadId { threadId -> timestamp }
const lastManualRetry = new Map();

// ── Queue management ──────────────────────────────────────────────────────────

/**
 * Add a failed submission to the retry queue.
 * payload: the same object passed to handleNewPost (minus the Discord objects)
 */
function enqueue({ threadId, reportType, title, description, discordUser, discordUserId, discordChannel, discordMessageId, attachments, isSuggestion }) {
  // Don't double-add the same thread
  if (queue.find(q => q.threadId === threadId)) return;

  const entry = {
    threadId,
    reportType,
    title,
    description,
    discordUser,
    discordUserId,
    discordChannel,
    discordMessageId,
    attachments: attachments || [],
    isSuggestion: !!isSuggestion,
    attempts: 0,
    addedAt: Date.now(),
    nextRetryAt: Date.now() + RETRY_INTERVAL,
  };

  queue.push(entry);
  saveQueue(queue);
  console.log(`[RetryQueue] Queued failed report: "${title}" (${threadId})`);
}

function remove(threadId) {
  queue = queue.filter(q => q.threadId !== threadId);
  saveQueue(queue);
}

function getEntry(threadId) {
  return queue.find(q => q.threadId === threadId) || null;
}

function size() {
  return queue.length;
}

// ── Retry logic ───────────────────────────────────────────────────────────────

/**
 * Attempt to submit one queued entry. Returns reportId on success, null on failure.
 */
async function attemptSubmit(entry, { handleNewPost, client, WATCHED_CHANNELS, threadReportMap }) {
  entry.attempts++;
  console.log(`[RetryQueue] Attempting "${entry.title}" (attempt ${entry.attempts})`);

  try {
    // Re-fetch the Discord thread so we have a live object
    const thread = await client.channels.fetch(entry.threadId).catch(() => null);
    if (!thread) {
      console.warn(`[RetryQueue] Thread ${entry.threadId} not found — skipping`);
      remove(entry.threadId);
      return null;
    }

    // Try to get the starter message
    let starterMessage = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
    if (!starterMessage) {
      const msgs = await thread.messages.fetch({ limit: 5 }).catch(() => null);
      starterMessage = msgs?.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first() || null;
    }

    // If still no starter, build a minimal synthetic one from stored data
    const syntheticStarter = starterMessage || {
      content: entry.description,
      author: { tag: entry.discordUser, id: entry.discordUserId, displayAvatarURL: () => null },
      id: entry.discordMessageId,
      attachments: { size: 0, values: () => [] },
    };

    const reportId = await handleNewPost({
      thread,
      starterMessage: syntheticStarter,
      reportType: entry.reportType,
      client,
    });

    if (reportId) {
      console.log(`[RetryQueue] ✓ Success for "${entry.title}" → report ${reportId}`);
      threadReportMap.set(entry.threadId, reportId);
      remove(entry.threadId);
      return reportId;
    }

  } catch (err) {
    console.error(`[RetryQueue] Attempt failed for "${entry.title}":`, err.message);
  }

  // Schedule next auto-retry
  entry.nextRetryAt = Date.now() + RETRY_INTERVAL;
  saveQueue(queue);
  return null;
}

// ── Auto-retry loop ───────────────────────────────────────────────────────────

function startAutoRetry(deps) {
  setInterval(async () => {
    const now = Date.now();
    const due = queue.filter(e => e.nextRetryAt <= now && e.attempts < MAX_ATTEMPTS);

    if (!due.length) return;
    console.log(`[RetryQueue] Auto-retry: ${due.length} entry/entries due`);

    for (const entry of due) {
      const reportId = await attemptSubmit(entry, deps);

      // If exhausted max attempts, give up and notify the thread
      if (!reportId && entry.attempts >= MAX_ATTEMPTS) {
        console.error(`[RetryQueue] Giving up on "${entry.title}" after ${MAX_ATTEMPTS} attempts`);
        try {
          const thread = await deps.client.channels.fetch(entry.threadId).catch(() => null);
          if (thread) {
            await thread.send(
              `> ❌ **DevTrack could not log this report after multiple attempts.**\n> Please use \`/reopen\` to retry manually, or contact an admin.`
            ).catch(() => {});
          }
        } catch {}
        remove(entry.threadId);
      }

      await new Promise(r => setTimeout(r, 500)); // stagger attempts
    }
  }, RETRY_INTERVAL);

  console.log(`[RetryQueue] Auto-retry started. Queue has ${queue.length} pending entries.`);
}

// ── Manual retry via Discord button ──────────────────────────────────────────

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Send the failure message with a Retry button.
 * Call this instead of the plain thread.send in handler.js on failure.
 */
async function sendFailureMessage(thread, title) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`retry_report:${thread.id}`)
      .setLabel('↺ Retry')
      .setStyle(ButtonStyle.Secondary)
  );

  await thread.send({
    content: `> ⚠️ **DevTrack had trouble logging this report.** It's been queued for automatic retry.\n> You can also press **Retry** below (1 minute cooldown).`,
    components: [row],
  }).catch(() => {});
}

/**
 * Handle the retry button interaction.
 * Wire this into your interactionCreate handler.
 */
async function handleRetryButton(interaction, deps) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith('retry_report:')) return false;

  const threadId = interaction.customId.split(':')[1];
  const entry    = getEntry(threadId);

  // Cooldown check
  const lastRetry = lastManualRetry.get(threadId) || 0;
  const elapsed   = Date.now() - lastRetry;
  if (elapsed < BUTTON_COOLDOWN) {
    const secsLeft = Math.ceil((BUTTON_COOLDOWN - elapsed) / 1000);
    await interaction.reply({
      content: `⏳ Please wait **${secsLeft}s** before retrying again.`,
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  if (!entry) {
    // Already succeeded via auto-retry
    await interaction.reply({
      content: `✅ This report has already been successfully submitted.`,
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  lastManualRetry.set(threadId, Date.now());

  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  const reportId = await attemptSubmit(entry, deps);

  if (reportId) {
    const DASHBOARD = process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app';
    await interaction.editReply({
      content: `✅ **Report submitted successfully!**\n${DASHBOARD}#report/${reportId}`,
    }).catch(() => {});

    // Update the original failure message — remove the retry button
    await interaction.message.edit({ components: [] }).catch(() => {});
  } else {
    const secsUntilAuto = Math.ceil((entry.nextRetryAt - Date.now()) / 1000 / 60);
    await interaction.editReply({
      content: `❌ Still failing. Auto-retry will try again in ~${secsUntilAuto} minute(s). You can try again in 1 minute.`,
    }).catch(() => {});
  }

  return true;
}

module.exports = { enqueue, remove, getEntry, size, startAutoRetry, sendFailureMessage, handleRetryButton };