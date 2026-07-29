// api/notifications.js
// Stores per-user notifications in data/notifications.json on GitHub
// Structure: { notifications: [ { id, forUser, fromUser, taskId, taskName, commentText, timestamp }, ... ] }
//
// GET    /api/notifications?user=NAME  → returns unread notifications for that user
// POST   /api/notifications            → body: { forUser, fromUser, taskId, taskName, commentText }
// DELETE /api/notifications            → body: { id } to dismiss one
//                                      → body: { clearAll: true, user: NAME } to clear all for user

const https = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/notifications.json';

function githubRequest(method, endpoint, body) {
  return new Promise(function(resolve, reject) {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path:     endpoint,
      method:   method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent':    'asset-tracker',
        'Accept':        'application/vnd.github.v3+json',
        'Content-Type':  'application/json'
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFile() {
  const res = await githubRequest('GET', '/repos/' + REPO + '/contents/' + PATH + '?ref=' + BRANCH);
  if (res.status === 404) return { content: { notifications: [] }, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  if (!Array.isArray(content.notifications)) content.notifications = [];
  return { content, sha: res.body.sha };
}

async function putFile(content, sha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = { message: 'Update notifications', content: encoded, branch: BRANCH };
  if (sha) payload.sha = sha;
  const res = await githubRequest('PUT', '/repos/' + REPO + '/contents/' + PATH, payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res;
}

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REPO || !GITHUB_TOKEN) return res.status(500).json({ error: 'GitHub not configured' });

  // ── GET — fetch notifications for a user ──────────────
  if (req.method === 'GET') {
    try {
      const user = (req.query && req.query.user) ? String(req.query.user).trim() : '';
      if (!user) return res.status(400).json({ error: 'user query param required' });
      const { content } = await getFile();
      const userNotifs = content.notifications.filter(function(n) {
        return n.forUser === user;
      });
      // Return newest first
      userNotifs.sort(function(a, b) {
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
      return res.status(200).json(userNotifs);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST — create a notification ──────────────────────
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const forUser     = String(body.forUser     || '').trim();
      const fromUser    = String(body.fromUser    || 'Someone').trim();
      const taskId      = String(body.taskId      || '').trim();
      const taskName    = String(body.taskName    || 'Task').trim();
      const commentText = String(body.commentText || '').trim();

      if (!forUser)  return res.status(400).json({ error: 'forUser is required' });
      if (!taskId)   return res.status(400).json({ error: 'taskId is required' });

      const newNotif = {
        id:          crypto.randomUUID(),
        forUser,
        fromUser,
        taskId,
        taskName,
        commentText,
        timestamp:   new Date().toISOString()
      };

      const { content, sha } = await getFile();

      // Avoid duplicate notifications: same forUser + fromUser + taskId within 60 seconds
      const sixtySecondsAgo = Date.now() - 60000;
      const isDuplicate = content.notifications.some(function(n) {
        return n.forUser  === forUser
            && n.fromUser === fromUser
            && n.taskId   === taskId
            && new Date(n.timestamp).getTime() > sixtySecondsAgo;
      });
      if (isDuplicate) return res.status(200).json({ ok: true, duplicate: true });

      content.notifications.push(newNotif);

      // Cap at 500 total notifications to keep file size sane
      if (content.notifications.length > 500) {
        content.notifications = content.notifications.slice(-500);
      }

      await putFile(content, sha);
      return res.status(201).json({ ok: true, notification: newNotif });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE — dismiss one or clear all for user ────────
  if (req.method === 'DELETE') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const { content, sha } = await getFile();

      if (body.clearAll === true) {
        const user = String(body.user || '').trim();
        if (!user) return res.status(400).json({ error: 'user is required for clearAll' });
        const before = content.notifications.length;
        content.notifications = content.notifications.filter(function(n) {
          return n.forUser !== user;
        });
        const removed = before - content.notifications.length;
        await putFile(content, sha);
        return res.status(200).json({ ok: true, removed });
      }

      if (body.id) {
        const id = String(body.id).trim();
        const before = content.notifications.length;
        content.notifications = content.notifications.filter(function(n) {
          return n.id !== id;
        });
        if (content.notifications.length === before) {
          return res.status(404).json({ error: 'Notification not found' });
        }
        await putFile(content, sha);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Provide id or clearAll + user' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
module.exports = handler;
