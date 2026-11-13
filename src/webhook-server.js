// webhook-server.js
// Simple HTTP server the backend calls to trigger Discord actions

const http = require('http');
const { applyThreadAction, sendServerAlert, updateImportReaction, sendPatchFixNotice, sendTesterPing } = require('./discord-service');
const reportPause = require('./report-pause');
const qaCheck = require('./qa-check');
const modelViewer = require('./model-viewer');

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

    if (req.method !== 'POST' || !['/action', '/alert', '/import-status', '/patch-fix', '/ping-testers', '/reports-pause-state', '/qa-check', '/qa-check-update', '/model-rbxm', '/linear-refresh', '/board-digest', '/board-ping'].includes(req.url)) {
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

      // A dev was added or changed on the Developers page: redo the Linear dots now.
      // The Assets board: the owner's daily check-in DM, and asking a dev how a task is going.
      if (req.url === '/board-digest' || req.url === '/board-ping') {
        try {
          const board = require('./board');
          const how = req.url === '/board-digest' ? await board.digest(body) : await board.ping(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, how }));
        } catch (err) {
          console.error(`[Webhook] ${req.url}:`, err.message);
          res.writeHead(err.status || 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url === '/linear-refresh') {
        require('./linear-status').refreshSoon(1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // A .rbxm saved from Studio. Answered only once it's posted, so the backend's outbox tries again if not.
      if (req.url === '/model-rbxm') {
        try {
          await modelViewer.postRbxm(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          console.error('[Webhook] model-rbxm:', err.message);
          res.writeHead(err.status || 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Tester QA: ask the reporter to confirm a fix, or retire that request.
      if (req.url === '/qa-check' || req.url === '/qa-check-update') {
        if (!body.threadId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'threadId is required' }));
          return;
        }
        if (req.url === '/qa-check') {
          // Answered only once it is posted, so a check the bot could not post stays in the backend's outbox.
          await qaCheck.postCheck(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        await qaCheck.updateCheck(body);
        return;
      }

      if (req.url === '/patch-fix') {
        const { title, reportType, bugLevel, category, assigneeName, summary } = body;
        if (!title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'title is required' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        await sendPatchFixNotice({ title, reportType, bugLevel, category, assigneeName, summary });
        return;
      }

      if (req.url === '/ping-testers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        await sendTesterPing();
        return;
      }

      if (req.url === '/reports-pause-state') {
        const { paused } = body;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        reportPause.setPaused(paused);
        console.log(`[Webhook] Report pause state set to: ${paused}`);
        if (!paused) {
          await reportPause.pingPendingAttempts();
        }
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

      const { threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner, verifiedBy, proof } = body;

      if (!threadId || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'threadId and action are required' }));
        return;
      }

      console.log(`[Webhook] Received action: ${action} notifyOwner: ${notifyOwner} for thread ${threadId}`);

      // Fire and forget — respond immediately, Discord call happens async
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

      await applyThreadAction({ threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner, verifiedBy, proof });

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
