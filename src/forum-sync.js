// forum-sync.js
// Keeps DevTrack in step with the report forums, so /syncreport is only
// needed in odd cases. Every SWEEP_MINUTES (and when the bot starts) it looks
// at every open post in the watched forums and the newest archived ones:
//
//   - a post with no report, made while the bot was down or after logging it
//     failed, gets one, with its replies, as if it had just been posted. Posts
//     made while reports were paused or whose report was deleted on the
//     dashboard stay unlogged, and posts older than
//     FORUM_SYNC_DAYS (14) are left alone so old threads are never pulled in.
//   - replies the bot missed while it was down are logged, in order. Each
//     message is logged with its Discord id, so nothing is logged twice.
//   - a post renamed in Discord renames its report.
//
// Also here, as they happen: an edited opening message updates the report's
// description, and a deleted post is recorded on its report (see
// onThreadDelete).

const axios = require('axios');
const { logMessage, fromMessage } = require('./message-logger');
const reportPause = require('./report-pause');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;
const SWEEP_MINUTES = Number(process.env.FORUM_SYNC_MINUTES || 10);
const MAX_AGE_DAYS = Number(process.env.FORUM_SYNC_DAYS || 14);
const NEW_POST_GRACE_MS = 5 * 60 * 1000; // ThreadCreate is still busy with posts this new
const ARCHIVED_PAGES = 1;                // 100 archived posts per forum

const api = (method, path, data) => axios({
  method, url: `${API_URL}/api/bot${path}`, data,
  headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET }, timeout: 30000,
}).then(r => r.data);

let deps = null; // { client, WATCHED_CHANNELS, threadReportMap, handleNewPost }
const lastSeen = new Map(); // threadId -> the post's last message id when it was last caught up
const creating = new Set();

const newer = (a, b) => BigInt(a) > BigInt(b);

// Logs every message in the post after afterId that is not from a bot. Returns how many.
async function backfill(thread, reportId, afterId) {
  let after = afterId;
  let logged = 0;
  for (;;) {
    const batch = await thread.messages.fetch({ limit: 100, after });
    if (!batch.size) break;
    const messages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const message of messages) {
      if (message.author?.bot || message.system) continue;
      if (!message.content && !message.attachments?.size) continue;
      await logMessage(fromMessage(message, reportId));
      logged++;
    }
    after = messages[messages.length - 1].id;
    if (batch.size < 100) break;
  }
  return logged;
}

async function starterOf(thread) {
  const starter = await thread.fetchStarterMessage({ cache: false }).catch(() => null);
  if (starter) return starter;
  const first = await thread.messages.fetch({ limit: 1, after: '0' }).catch(() => null);
  return first?.first() || null;
}

// A post with no report: logged the way a new post is, then its replies.
async function createFor(thread, reportType) {
  if (creating.has(thread.id)) return;
  creating.add(thread.id);
  try {
    const starterMessage = await starterOf(thread);
    if (!starterMessage) return console.error(`[ForumSync] No opening message in "${thread.name}" (${thread.id}); left for /syncreport`);
    const reportId = await deps.handleNewPost({ thread, starterMessage, reportType, client: deps.client });
    if (!reportId) return;
    deps.threadReportMap.set(thread.id, reportId);
    if (reportType === 'suggestion') await starterMessage.react('⭐').catch(() => {}); // as ThreadCreate does, for upvotes
    const replies = await backfill(thread, reportId, starterMessage.id);
    lastSeen.set(thread.id, thread.lastMessageId);
    console.log(`[ForumSync] Logged missed post "${thread.name}" (${thread.id}) as report ${reportId}, with ${replies} repl${replies === 1 ? 'y' : 'ies'}`);
  } finally {
    creating.delete(thread.id);
  }
}

async function postsIn(forum) {
  const posts = [];
  const active = await forum.threads.fetchActive().catch(() => null);
  posts.push(...(active?.threads?.values() || []));
  let before;
  for (let page = 0; page < ARCHIVED_PAGES; page++) {
    const archived = await forum.threads.fetchArchived({ limit: 100, before }).catch(() => null);
    const threads = [...(archived?.threads?.values() || [])];
    posts.push(...threads);
    if (!archived?.hasMore || !threads.length) break;
    before = threads[threads.length - 1];
  }
  // fetchActive covers the whole server, so keep this forum's posts only.
  return [...new Map(posts.filter(t => t.parentId === forum.id).map(t => [t.id, t])).values()];
}

let sweeping = false;
async function sweep() {
  if (sweeping || !deps) return;
  sweeping = true;
  const counts = { created: 0, caughtUp: 0 };
  try {
    for (const [forumId, reportType] of Object.entries(deps.WATCHED_CHANNELS)) {
      if (!['bug', 'suggestion'].includes(reportType)) continue;
      const forum = await deps.client.channels.fetch(forumId).catch(() => null);
      if (!forum?.threads?.fetchActive) continue;
      const posts = await postsIn(forum);
      if (!posts.length) continue;
      const { reports, skip } = await api('post', '/thread-sync', { threads: posts.map(t => ({ threadId: t.id, title: t.name })) });
      const leaveAlone = new Set(skip);

      for (const thread of posts) {
        try {
          const known = reports[thread.id];
          if (!known) {
            const age = Date.now() - (thread.createdTimestamp || 0);
            if (age < NEW_POST_GRACE_MS || age > MAX_AGE_DAYS * 86400000) continue;
            if (leaveAlone.has(thread.id) || (reportType === 'bug' && reportPause.isPaused())) continue;
            await createFor(thread, reportType);
            counts.created++;
            continue;
          }
          deps.threadReportMap.set(thread.id, known.reportId);
          // Nothing new since the last look, or nothing to measure from: reports logged before
          // messages kept their Discord id are caught up from their next message on.
          const last = thread.lastMessageId;
          if (!last || !known.lastMessageId || lastSeen.get(thread.id) === last || !newer(last, known.lastMessageId)) continue;
          const logged = await backfill(thread, known.reportId, known.lastMessageId);
          lastSeen.set(thread.id, last);
          if (logged) {
            counts.caughtUp += logged;
            console.log(`[ForumSync] Logged ${logged} missed message(s) in "${thread.name}" (${thread.id})`);
          }
        } catch (err) {
          console.error(`[ForumSync] Could not sync "${thread.name}" (${thread.id}):`, err.response?.data?.error || err.message);
        }
      }
    }
    if (counts.created || counts.caughtUp) console.log(`[ForumSync] Sweep done: ${counts.created} missed post(s) logged, ${counts.caughtUp} missed message(s) logged`);
  } catch (err) {
    console.error('[ForumSync] Sweep failed:', err.response?.data?.error || err.message);
  } finally {
    sweeping = false;
  }
}

// The opening message of a watched post was edited. In a forum it has the post's own id.
async function onMessageUpdate(oldMessage, newMessage) {
  if (!deps) return;
  const thread = newMessage.channel;
  if (!thread?.isThread?.() || newMessage.id !== thread.id) return;
  if (!['bug', 'suggestion'].includes(deps.WATCHED_CHANNELS[thread.parentId])) return;
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message?.content || message.author?.bot) return;
  if (!oldMessage.partial && oldMessage.content === message.content) return; // an embed loading, not an edit
  try {
    await api('post', '/report-description', { threadId: thread.id, description: message.content });
  } catch (err) {
    console.error(`[ForumSync] Could not update the description for ${thread.id}:`, err.response?.data?.error || err.message);
  }
}

// A watched post was deleted. Its report stays, and is marked as having no
// post any more; a QA check waiting in it is withdrawn and taken off QA Requests.
async function onThreadDelete(thread, closeEscalation) {
  if (!deps || !deps.WATCHED_CHANNELS[thread.parentId]) return;
  deps.threadReportMap.delete(thread.id);
  lastSeen.delete(thread.id);
  try {
    const { reports, checks } = await api('post', '/thread-deleted', { threadId: thread.id });
    for (const check of checks) await closeEscalation(check, '🗑️ **Withdrawn:** the report\'s post was deleted.');
    if (reports.length) console.log(`[ForumSync] Post ${thread.id} deleted; report ${reports.join(', ')} kept`);
  } catch (err) {
    console.error(`[ForumSync] Could not record that post ${thread.id} was deleted:`, err.response?.data?.error || err.message);
  }
}

function start(options) {
  deps = options;
  if (!(SWEEP_MINUTES > 0)) return console.log('[ForumSync] Off (FORUM_SYNC_MINUTES=0)');
  setTimeout(sweep, 30 * 1000); // after the startup work settles
  setInterval(sweep, SWEEP_MINUTES * 60 * 1000);
  console.log(`[ForumSync] Sweeping the report forums every ${SWEEP_MINUTES} minutes`);
}

module.exports = { start, sweep, backfill, onMessageUpdate, onThreadDelete };
