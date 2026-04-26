// discord-service.js
// Handles all outbound Discord actions: tagging threads, posting replies, mentioning users

const { Client, GatewayIntentBits } = require('discord.js');

// ── Tag IDs per channel ───────────────────────────────────────────────────────
// Each forum channel has its own unique tag IDs
const CHANNEL_TAGS = {
  // 📩┃rr
  '1469702083803349134': {
    accepted:  '1497996050403954951', // Approve
    declined:  '1497996021379367185', // Declined
    resolved:  '1497996122411634739', // Resolved
    minor:     '1497996159405264926',
    moderate:  '1497996234135310456',
    major:     '1497996271183724564',
  },
  // 📩┃suggestions
  '1469718819306999881': {
    accepted:  '1485771424881705070', // Accepted
    declined:  '1485771449628229822', // Rejected
    resolved:  '1485771518029070356', // Implemented
  },
  // nda-bug-reports
  '1496315962427969656': {
    accepted:  '1497459600755265667',
    declined:  '1497459634477334608',
    minor:     '1497459678236508190',
    moderate:  '1497459716815716442',
    major:     '1497459759366803516',
    resolved:  '1497459800076714064',
  },
  // 📩┃expeditions-rr
  '1496927598561988649': {
    accepted:  '1497995758174076978', // Approved
    declined:  '1497995726477594644', // Declined
    resolved:  '1497995818907603144', // Resolved
    minor:     '1497995854462717993',
    moderate:  '1497995898242990111',
    major:     '1497995957026160730',
  },
};

// Fallback tags (nda-bug-reports) if channel not found
const DEFAULT_TAGS = CHANNEL_TAGS['1496315962427969656'];

function getTagMap(thread) {
  // Try parent channel ID first (forum channel), then thread ID
  const parentId = thread.parentId;
  return CHANNEL_TAGS[parentId] || CHANNEL_TAGS[thread.id] || DEFAULT_TAGS;
}

// ── Messages ──────────────────────────────────────────────────────────────────
function buildMessage(action, opts = {}) {
  const { mention, bugLevel, devNotes, assigneeName } = opts;
  const ping = mention ? `<@${mention}>` : '';

  switch (action) {
    case 'in_progress':
      return [
        `${ping} 🔧 **This report is now being worked on.**`,
        assigneeName ? `> **Assigned to:** ${assigneeName}` : '',
        `> We'll update you when it moves to review.`,
      ].filter(Boolean).join('\n');

    case 'reviewing':
      return [
        `${ping} 🔬 **This report has been fixed and is now in QA review.**`,
        `> Our testers are verifying the fix. We'll let you know when it's resolved.`,
      ].filter(Boolean).join('\n');

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

    // Get tag map for this specific channel
    const tagMap = getTagMap(thread);

    // Build new tag list — remove all managed tags first, then add new ones
    const managedTagIds = new Set(Object.values(tagMap));
    const currentTags = (thread.appliedTags || []).filter(id => !managedTagIds.has(id));

    const newTags = [...currentTags];
    if (action === 'accepted'    && tagMap.accepted)  newTags.push(tagMap.accepted);
    if (action === 'declined'    && tagMap.declined)  newTags.push(tagMap.declined);
    if (action === 'resolved'    && tagMap.resolved)  newTags.push(tagMap.resolved);
    if (action === 'in_progress' && tagMap.accepted)  newTags.push(tagMap.accepted);
    if (action === 'reviewing'   && tagMap.accepted)  newTags.push(tagMap.accepted);
    if (bugLevel && tagMap[bugLevel]) newTags.push(tagMap[bugLevel]);

    // Discord allows max 5 tags per thread
    const finalTags = [...new Set(newTags)].slice(0, 5);

    await thread.setAppliedTags(finalTags);
    console.log(`[Discord] Tags updated on thread ${threadId}: ${finalTags.join(', ')}`);

    // Build and send message
    const isSuggestion = reportType === 'suggestion';
    let messageAction = action;
    if (isSuggestion) {
      messageAction = action === 'accepted'    ? 'accepted_suggestion'
                    : action === 'declined'    ? 'declined_suggestion'
                    : action === 'resolved'    ? 'resolved_suggestion'
                    : action === 'in_progress' ? 'in_progress'
                    : action === 'reviewing'   ? 'reviewing'
                    : action;
    }

    console.log(`[Discord] notifyOwner: ${notifyOwner}, userId: ${discordUserId}`);
    const pingId = notifyOwner ? discordUserId : null;
    const message = buildMessage(messageAction, { mention: pingId, bugLevel, devNotes, assigneeName });
    console.log(`[Discord] message: ${message.slice(0, 80)}`);

    if (message) {
      await thread.send(message);
      console.log(`[Discord] Message posted in thread ${threadId}`);
    }

  } catch (err) {
    console.error(`[Discord] Failed to apply thread action:`, err.message);
  }
}

module.exports = { applyThreadAction };