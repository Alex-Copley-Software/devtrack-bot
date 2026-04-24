const axios = require('axios');
const FormData = require('form-data');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const BOT_SECRET = process.env.BOT_SECRET;

// Keywords used to detect priority from the post content
const PRIORITY_RULES = [
  { priority: 'critical', keywords: ['crash', 'down', 'broken', 'critical', 'urgent', 'not working', 'cant login', "can't login", 'data loss'] },
  { priority: 'high',     keywords: ['major', 'serious', 'important', 'high priority', 'bad bug', 'regression'] },
  { priority: 'low',      keywords: ['minor', 'small', 'nitpick', 'cosmetic', 'typo', 'low priority'] },
];

// Extract tags from message content and thread name
function extractTags(title, content) {
  const combined = (title + ' ' + content).toLowerCase();
  const tags = [];

  const tagMap = {
    mobile:        ['mobile', 'ios', 'android', 'iphone', 'ipad', 'phone'],
    auth:          ['login', 'logout', 'auth', 'password', 'token', 'session'],
    api:           ['api', 'endpoint', 'request', '500', '404', 'timeout'],
    ui:            ['ui', 'button', 'layout', 'style', 'css', 'design', 'display'],
    performance:   ['slow', 'performance', 'lag', 'freeze', 'memory', 'cpu', 'load'],
    notifications: ['notification', 'badge', 'alert', 'push'],
    export:        ['export', 'download', 'csv', 'pdf'],
    import:        ['import', 'upload', 'csv'],
    settings:      ['settings', 'preferences', 'config'],
    database:      ['database', 'db', 'query', 'sql'],
  };

  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some((kw) => combined.includes(kw))) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 5);
}

// Detect priority from content
function detectPriority(title, content) {
  const combined = (title + ' ' + content).toLowerCase();
  for (const rule of PRIORITY_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return rule.priority;
    }
  }
  return 'medium';
}

// Build the list of Discord attachment URLs to pass to the API
function buildAttachmentList(message) {
  if (!message || !message.attachments || message.attachments.size === 0) return [];

  return [...message.attachments.values()].map((att) => ({
    url: att.url,
    filename: att.name,
    contentType: att.contentType || 'application/octet-stream',
  }));
}

async function handleNewPost({ thread, starterMessage, reportType }) {
  const title = thread.name;
  const content = starterMessage?.content || '';
  const discordUser = starterMessage?.author?.tag || 'unknown';
  const discordMessageId = starterMessage?.id || thread.id;
  const channelName = thread.parent?.name || 'unknown';

  const priority = detectPriority(title, content);
  const tags = extractTags(title, content);
  const attachments = buildAttachmentList(starterMessage);

  console.log(`[Handler] Processing: "${title}"`);
  console.log(`  Type:        ${reportType}`);
  console.log(`  Priority:    ${priority}`);
  console.log(`  Tags:        ${tags.join(', ') || 'none'}`);
  console.log(`  Attachments: ${attachments.length}`);
  console.log(`  Author:      ${discordUser}`);

  const form = new FormData();
  form.append('type', reportType);
  form.append('title', title);
  form.append('description', content || '(No description provided)');
  form.append('priority', priority);
  form.append('discordUser', discordUser);
  form.append('discordUserId', starterMessage?.author?.id || '');
  form.append('discordThreadId', thread.id || '');
  form.append('discordChannel', `#${channelName}`);
  form.append('discordMessageId', discordMessageId);

  if (tags.length > 0) {
    form.append('tags', tags.join(','));
  }

  if (attachments.length > 0) {
    form.append('attachmentUrls', JSON.stringify(attachments));
  }

  try {
    const response = await axios.post(`${API_URL}/api/bot/report`, form, {
      headers: {
        ...form.getHeaders(),
        'x-bot-secret': BOT_SECRET,
      },
      timeout: 30000,
    });

    console.log(`[Handler] Report created: ID ${response.data.reportId}`);

    // React to the Discord post to confirm it was logged
    if (starterMessage) {
      await starterMessage.react('✅').catch(() => {});
    }

    // Post a confirmation reply in the thread
    await thread.send(
      `> 📋 **Logged to DevTrack** — this ${reportType === 'suggestion' ? 'suggestion' : 'report'} has been added to the engineering dashboard.\n> Priority detected: **${priority}** · Tags: ${tags.length ? tags.map(t => `\`${t}\``).join(' ') : 'none'}`
    ).catch(() => {});

  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`[Handler] Skipped duplicate: "${title}" (already in database)`);
      return;
    }
    console.error(`[Handler] Failed to submit report "${title}":`, err.response?.data || err.message);

    // Notify in thread if submission failed
    await thread.send(
      '> ⚠️ DevTrack Bot had trouble logging this report. An engineer has been notified.'
    ).catch(() => {});
  }
}

module.exports = { handleNewPost };
