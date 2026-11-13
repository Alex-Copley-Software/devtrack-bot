// board.js
// The Discord side of the Assets board (DevTrack's /assets/ page).
//
//   reading     every message in the channels the board reads goes to the backend
//               (/api/bot/board/messages), which goes through them every few hours and
//               lists the updates on the page. The board says which channels: each dev's
//               place on the Developers page and the channels picked in its settings. A
//               forum counts for every post in it, a category for every channel in it.
//   check-ins   once a day the backend sends the owner a DM (via the webhook, /board-digest)
//               listing the in-progress tasks nobody has heard about lately.
//   ping        "Ask how it's going" on the page: a DM to the dev (/board-ping), or a
//               message in their place on Discord if their DMs are closed.

const axios = require('axios');
const { EmbedBuilder, ChannelType } = require('discord.js');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const OWNER = String(process.env.PERSONAL_OWNER_DISCORD_ID || process.env.CONVERT_OWNER_ID || '618957089833877518').trim();
const WATCH_MS = 5 * 60 * 1000;
const bot = () => ({ headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 15000 });

let client = null;
let watched = new Set();

async function loadWatch() {
  try {
    const { data } = await axios.get(`${API_URL}/api/bot/board/watch`, bot());
    const next = new Set(data.channelIds || []);
    if ([...next].sort().join() !== [...watched].sort().join()) console.log(`[Board] Reading ${next.size} channel(s) for the Assets board`);
    watched = next;
  } catch (err) {
    console.error('[Board] Could not load the channels to read:', err.response?.data?.error || err.message);
  }
}

function start(discordClient) {
  client = discordClient;
  loadWatch();
  setInterval(loadWatch, WATCH_MS);
}

// The message's channel, the thread's forum or channel, or the category above either.
function isWatched(message) {
  if (!watched.size || !message.guildId) return false;
  const ch = message.channel;
  return [message.channelId, ch?.parentId, ch?.parent?.parentId].some(id => id && watched.has(id));
}

// Called for every message from a person; sends it on if it's in a channel the board reads.
function onMessage(message) {
  if (!isWatched(message)) return;
  const ch = message.channel;
  const thread = ch?.isThread?.() ? ch : null;
  const payload = {
    id: message.id,
    channelId: thread ? thread.parentId : message.channelId,
    threadId: thread ? thread.id : null,
    place: thread ? `${thread.parent?.name || 'forum'} › ${thread.name}` : ch?.name || '',
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.globalName || message.author.username,
    content: message.content || '',
    url: message.url,
    postedAt: new Date(message.createdTimestamp).toISOString(),
    attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType, size: a.size, width: a.width, height: a.height })),
  };
  if (!payload.content && !payload.attachments.length) return;
  axios.post(`${API_URL}/api/bot/board/messages`, payload, { ...bot(), timeout: 60000 })
    .catch(err => console.error('[Board] Could not send a message to the board:', err.response?.data?.error || err.message));
}

// "Linear just changed": the board reads it again now instead of within the minute.
function linearChanged() {
  axios.post(`${API_URL}/api/bot/board/sync`, {}, bot()).catch(() => {});
}

class Refused extends Error { constructor(message) { super(message); this.status = 400; } }

// The owner's daily DM: { date, stale: [{ unit, task, dev, days, url }], updates, url, updatesUrl }
async function digest(p) {
  if (!client?.isReady()) throw new Error('The bot is not connected to Discord yet');
  const owner = await client.users.fetch(OWNER).catch(() => null);
  if (!owner) throw new Refused(`Can't find the owner account ${OWNER}`);
  const lines = (p.stale || []).slice(0, 15).map(s => `• [**${s.unit} › ${s.task}**](${s.url}): ${s.dev || 'nobody named'}, ${s.days} day${s.days === 1 ? '' : 's'} with no news`);
  if ((p.stale || []).length > 15) lines.push(`…and ${p.stale.length - 15} more`);
  const embed = new EmbedBuilder()
    .setColor(0xff9f0a)
    .setTitle((p.stale || []).length ? `🔎 ${p.stale.length} task${p.stale.length === 1 ? '' : 's'} to check in on` : '📬 Updates waiting')
    .setDescription([...lines, '', `[Open the Assets board](${p.url})${p.updates ? ` · **${p.updates}** update${p.updates === 1 ? '' : 's'} from Discord to go through: [see them](${p.updatesUrl})` : ''}`].join('\n').slice(0, 4000))
    .setFooter({ text: `DevTrack · ${p.date}` });
  await owner.send({ embeds: [embed] }).catch(err => { throw new Refused(`Could not DM the owner: ${err.message}`); });
}

// Ask a dev how a task is going: { userId, channelId, text, from }
async function ping(p) {
  if (!client?.isReady()) throw new Error('The bot is not connected to Discord yet');
  const text = `${p.text}\n-# Asked by ${p.from || 'the team'} via DevTrack`;
  if (p.userId) {
    const user = await client.users.fetch(p.userId).catch(() => null);
    if (user && await user.send(text).then(() => true).catch(() => false)) return 'dm';
  }
  // DMs closed (or no account): their place on Discord. A forum has no messages of its own: its newest open post.
  let place = p.channelId ? await client.channels.fetch(p.channelId).catch(() => null) : null;
  if (place?.type === ChannelType.GuildForum) {
    const active = await place.threads.fetchActive().catch(() => null);
    place = [...(active?.threads.values() || [])].filter(t => t.parentId === place.id).sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0] || null;
  }
  if (!place?.isTextBased?.() || !place.send) throw new Refused('Their DMs are closed and they have no channel or open post to ask in');
  await place.send({ content: p.userId ? `<@${p.userId}> ${text}` : text, allowedMentions: { users: p.userId ? [p.userId] : [] } });
  return 'channel';
}

module.exports = { start, onMessage, linearChanged, digest, ping, isWatched };
