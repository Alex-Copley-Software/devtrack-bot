// webhook-server.js
// Simple HTTP server the backend calls to trigger Discord actions

const http = require('http');
const { applyThreadAction, sendServerAlert, updateImportReaction } = require('./discord-service');

const PORT = process.env.BOT_WEBHOOK_PORT || 3002;
const SECRET = process.env.BOT_SECRET;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function start() {
  const server = http.createServer(async (req, res) => {
    // Auth check
    const secret = req.headers['x-bot-secret'];
    if (!secret || secret !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method !== 'POST' || !['/action', '/alert', '/import-status'].includes(req.url)) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await parseBody(req);
      if (req.url === '/alert') {
        const { kind, count, oldestAge, url } = body;
        if (!kind) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'kind is required' }));
          return;
        }

        console.log(`[Webhook] Received alert: ${kind} count: ${count}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        await sendServerAlert({ kind, count, oldestAge, url });
        return;
      }

      if (req.url === '/import-status') {
        const { channelId, messageId, status } = body;
        if (!channelId || !messageId || !status) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'channelId, messageId, and status are required' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        await updateImportReaction({ channelId, messageId, status });
        return;
      }

      const { threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner } = body;

      if (!threadId || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'threadId and action are required' }));
        return;
      }

      console.log(`[Webhook] Received action: ${action} notifyOwner: ${notifyOwner} for thread ${threadId}`);

      // Fire and forget — respond immediately, Discord call happens async
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

      await applyThreadAction({ threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner });

    } catch (err) {
      console.error('[Webhook] Error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`[Webhook] Bot webhook server listening on port ${PORT}`);
  });
}

module.exports = { start };
