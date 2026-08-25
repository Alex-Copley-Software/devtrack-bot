// report-pause.js
// Tracks whether new Discord bug reports should be blocked from entering the
// DevTrack queue, and pings threads that tried to report while paused once
// reports resume. Source of truth lives in the backend; this module just
// mirrors it in memory so ThreadCreate checks don't need a network round trip.

const axios = require('axios');
const { sendPausedThreadPing } = require('./discord-service');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

let paused = false;

function isPaused() {
  return paused;
}

function setPaused(value) {
  paused = !!value;
}

async function syncPauseState() {
  try {
    const r = await axios.get(`${API_URL}/api/bot/report-pause-status`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    paused = !!r.data?.paused;
    console.log(`[ReportPause] Synced pause state: ${paused ? 'PAUSED' : 'active'}`);
  } catch (err) {
    console.error('[ReportPause] Failed to sync pause state:', err.response?.data || err.message);
  }
}

async function registerPausedAttempt({ threadId, channelId, discordUserId, discordUser, title }) {
  try {
    await axios.post(`${API_URL}/api/bot/report-pause/attempt`, {
      threadId, channelId, discordUserId, discordUser, title,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      timeout: 10000,
    });
  } catch (err) {
    console.error('[ReportPause] Failed to register paused attempt:', err.response?.data || err.message);
  }
}

async function postPausedNotice(thread, discordUserId) {
  const mention = discordUserId ? `<@${discordUserId}> ` : '';
  await thread.send(
    [
      `${mention}⏸️ **Bug reports are paused right now.**`,
      `> This thread was **not** logged as a DevTrack ticket. You'll be pinged here once reports are back open.`,
      `> When they are, please open a **new** bug report thread — and check the change logs first to confirm this is still a bug and not intended behavior.`,
    ].join('\n')
  ).catch(err => console.error(`[ReportPause] Failed to post paused notice in thread ${thread.id}:`, err.message));
}

// Called once reports resume — pings every thread that tried to report while
// paused, one at a time, marking each pinged as it succeeds.
async function pingPendingAttempts() {
  let pending = [];
  try {
    const r = await axios.get(`${API_URL}/api/bot/report-pause/pending`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 15000,
    });
    pending = r.data || [];
  } catch (err) {
    console.error('[ReportPause] Failed to fetch pending paused attempts:', err.response?.data || err.message);
    return;
  }

  for (const attempt of pending) {
    const ok = await sendPausedThreadPing({ threadId: attempt.threadId, discordUserId: attempt.discordUserId });
    if (ok) {
      try {
        await axios.post(`${API_URL}/api/bot/report-pause/pending/${attempt.id}/mark-pinged`, {}, {
          headers: { 'x-bot-secret': BOT_SECRET },
          timeout: 10000,
        });
      } catch (err) {
        console.error(`[ReportPause] Failed to mark attempt ${attempt.id} pinged:`, err.response?.data || err.message);
      }
    }
  }
  console.log(`[ReportPause] Pinged ${pending.length} paused-thread attempt(s)`);
}

module.exports = { isPaused, setPaused, syncPauseState, registerPausedAttempt, postPausedNotice, pingPendingAttempts };
