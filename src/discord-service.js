// discord-service.js
// Handles all outbound Discord actions: tagging threads, posting replies, mentioning users

const { Client, GatewayIntentBits } = require('discord.js');

// ── Tag IDs ───────────────────────────────────────────────────────────────────
const TAGS = {
  bug: {
    accepted:  '1497308644528754849',
    declined:  '1497308691161157824',
    minor:     '1497308769242189824',
    moderate:  '1497308817493594264',
    major:     '1497308901509566587',
    resolved:  '1497309084893053028',
  },
  suggestion: {
    accepted:  '1497309301386248473',
    declined:  '1497309324433817651',
    resolved:  '1497309370772488322',
  }
};

// ── Messages ──────────────────────────────────────────────────────────────────
function buildMessage(action, opts = {}) {
  const { mention, bugLevel, devNotes, assigneeName } = opts;
  const ping = mention ? `<@${mention}>` : '';

  switch (action) {
    case 'accepted':
      return [
        `${ping} ✅ **Your report has been reviewed and accepted.**`,
        bugLevel ? `> **Severity:** ${bugLevel.charAt(0).toUpperCase() + bugLevel.slice(1)}` : '',
        assigneeName ? `> **Assigned to:** ${assigneeName}` : '',
        devNotes ? `> **Dev notes:** ${devNotes}` : '',
        `> We'll keep this thread updated as work progresses.`,
      ].filter(Boolean).join('\n');

    case 'declined':
      return [
        `${ping} 📋 **Thank you for your report.**`,
        `> After review, we've decided not to action this at this time.`,
        devNotes ? `> **Reason:** ${devNotes}` : '',
        `> We appreciate you taking the time to report this.`,
      ].filter(Boolean).join('\n');

    case 'resolved':
      return [
        `${ping} 🎉 **This has been fixed and resolved!**`,
        devNotes ? `> **Notes:** ${devNotes}` : '',
        `> Thanks for helping us improve. Please reopen if you experience this again.`,
      ].filter(Boolean).join('\n');

    case 'accepted_suggestion':
      return [
        `${ping} ✅ **Your suggestion has been accepted!**`,
        devNotes ? `> **Notes:** ${devNotes}` : '',
        assigneeName ? `> **Being worked on by:** ${assigneeName}` : '',
        `> We'll keep this thread updated as work progresses.`,
      ].filter(Boolean).join('\n');

    case 'declined_suggestion':
      return [
        `${ping} 📋 **Thank you for your suggestion.**`,
        `> After review, we've decided not to move forward with this at this time.`,
        devNotes ? `> **Reason:** ${devNotes}` : '',
        `> We appreciate the feedback!`,
      ].filter(Boolean).join('\n');

    case 'resolved_suggestion':
      return [
        `${ping} 🎉 **This suggestion has been implemented!**`,
        devNotes ? `> **Notes:** ${devNotes}` : '',
        `> Thanks for the great idea!`,
      ].filter(Boolean).join('\n');

    default:
      return '';
  }
}

// ── Discord client singleton ──────────────────────────────────────────────────
let _client = null;

async function getClient() {
  if (_client && _client.isReady()) return _client;
  return new Promise((resolve, reject) => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.once('ready', () => { _client = client; resolve(client); });
    client.once('error', reject);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });
}

// ── Core action ───────────────────────────────────────────────────────────────
async function applyThreadAction({ threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner }) {
  try {
    const client = await getClient();
    const thread = await client.channels.fetch(threadId);
    if (!thread) { console.error(`[Discord] Thread ${threadId} not found`); return; }

    const tagMap = TAGS[reportType] || TAGS.bug;

    // Build new tag list — remove all managed tags first, then add new ones
    const managedTagIds = new Set(Object.values(tagMap));
    const currentTags = (thread.appliedTags || []).filter(id => !managedTagIds.has(id));

    const newTags = [...currentTags];
    if (action === 'accepted' && tagMap.accepted)  newTags.push(tagMap.accepted);
    if (action === 'declined' && tagMap.declined)  newTags.push(tagMap.declined);
    if (action === 'resolved' && tagMap.resolved)  newTags.push(tagMap.resolved);
    if (bugLevel && tagMap[bugLevel])               newTags.push(tagMap[bugLevel]);

    // Discord allows max 5 tags per thread
    const finalTags = [...new Set(newTags)].slice(0, 5);

    // Apply tags
    await thread.setAppliedTags(finalTags);
    console.log(`[Discord] Tags updated on thread ${threadId}: ${finalTags.join(', ')}`);

    // Post reply message
    const isSuggestion = reportType === 'suggestion';
    let messageAction = action;
    if (isSuggestion) {
      messageAction = action === 'accepted' ? 'accepted_suggestion'
                    : action === 'declined' ? 'declined_suggestion'
                    : action === 'resolved' ? 'resolved_suggestion'
                    : action;
    }
    
    console.log('[Discord] notifyOwner:', notifyOwner, 'discordUserId:', discordUserId);
    const mentionId = notifyOwner ? discordUserId : null;
    console.log('[Discord] mentionId:', mentionId);
    const message = buildMessage(messageAction, { mention: mentionId, bugLevel, devNotes, assigneeName });
    console.log('[Discord] message preview:', message.slice(0, 100));

    // Only mention the user if they opted in by reacting
    const mentionId = notifyOwner ? discordUserId : null;
    const message = buildMessage(messageAction, { mention: mentionId, bugLevel, devNotes, assigneeName });
    if (message) {
      await thread.send(message);
      console.log(`[Discord] Message posted in thread ${threadId}`);
    }

  } catch (err) {
    console.error(`[Discord] Failed to apply thread action:`, err.message);
  }
}

module.exports = { applyThreadAction };