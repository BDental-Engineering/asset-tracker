// api/taskengagement.js
// Combined endpoint for task comments, notifications, and flagged task state
//
// GET  /api/taskengagement?user=NAME        → notifications for user
// GET  /api/taskengagement?taskId=ID        → comments + flag state for task
// GET  /api/taskengagement?allComments=1    → all comments (bulk load on login)
// GET  /api/taskengagement?allFlags=1       → all flags (bulk load on login)
// POST /api/taskengagement                  → body: { action, ... }
//   action: "comment"  → add a comment
//   action: "notify"   → create a notification
//   action: "flag"     → save flagged state
// DELETE /api/taskengagement                → body: { action, ... }
//   action: "comment"  → delete a comment
//   action: "notify"   → dismiss a notification (or clearAll)
//   action: "flag"     → remove a flag
//
// Storage (all in data/):
//   taskcomments.json   → migrated to { comments: [...] }
//                          was: { "taskId": [...] }  (old keyed format)
//                          was: { "taskId": [...], "comments": [...] } (mixed)
//   notifications.json  → { notifications: [...] }
//   flaggedtasks.json   → { flagged: { taskId: true }, updatedAt: '' }
//                          was: { "taskId": true }  (old flat format)
//                          was: ["taskId", ...]     (old array format)

const https  = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';

const PATH_COMMENTS = 'data/taskcomments.json';
const PATH_NOTIFS   = 'data/notifications.json';
const PATH_FLAGS    = 'data/flaggedtasks.json';

// ── GitHub helpers ─────────────────────────────────────────────────────────

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
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFile(path, fallback) {
  const res = await githubRequest('GET', '/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH);
  if (res.status === 404) return { content: fallback, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status + ' for ' + path);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

async function putFile(path, content, sha, message) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = { message: message || 'Update ' + path, content: encoded, branch: BRANCH };
  if (sha) payload.sha = sha;
  const res = await githubRequest('PUT', '/repos/' + REPO + '/contents/' + path, payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res;
}

// ── Normalise: comments ────────────────────────────────────────────────────
//
// Handles all three real-world shapes found in taskcomments.json:
//
//  Shape A — pure old keyed object (written by old taskcomments.js):
//    { "uuid1": [{...},{...}], "uuid2": [{...}] }
//
//  Shape B — pure new flat array (written by new taskengagement.js):
//    { "comments": [{...},{...}] }
//
//  Shape C — mixed (written by both systems into same file):
//    { "uuid1": [{...}], "comments": [{...}] }
//
//  Shape D — bare array (defensive):
//    [{...},{...}]
//
// Output is always: { comments: [ ...flatArray ] }
// After first write-back the file will be Shape B permanently.

function normaliseComments(raw) {
  var merged = [];
  var seenIds = {};

  function addComment(c) {
    if (!c || typeof c !== 'object') return;
    var id = c.id || '';
    if (id && seenIds[id]) return; // deduplicate
    if (id) seenIds[id] = true;
    merged.push(c);
  }

  // Shape D — bare array
  if (Array.isArray(raw)) {
    raw.forEach(addComment);
    return { comments: merged };
  }

  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function(key) {
      var val = raw[key];

      // Shape B — the new "comments" array key
      if (key === 'comments' && Array.isArray(val)) {
        val.forEach(addComment);
        return;
      }

      // Shape A / C — old keyed entries where key is a task UUID
      // Value must be an array of comment objects
      if (Array.isArray(val)) {
        val.forEach(function(c) {
          // Ensure taskId is set (old format stored it on the comment too,
          // but be safe in case it was missing)
          if (c && typeof c === 'object') {
            if (!c.taskId) c.taskId = key;
            addComment(c);
          }
        });
      }
    });
  }

  // Sort by timestamp ascending so oldest comments come first
  merged.sort(function(a, b) {
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });

  return { comments: merged };
}

// ── Normalise: flags ───────────────────────────────────────────────────────
//
//  Old flat:  { "uuid1": true, "uuid2": true }
//  Old array: ["uuid1", "uuid2"]
//  New:       { "flagged": { "uuid1": true }, "updatedAt": "..." }

function normaliseFlags(raw) {
  // New format — has a "flagged" key that is a plain object
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    raw.flagged &&
    typeof raw.flagged === 'object' &&
    !Array.isArray(raw.flagged)
  ) {
    return raw;
  }

  // Old array format
  if (Array.isArray(raw)) {
    var flagged = {};
    raw.forEach(function(id) { if (typeof id === 'string') flagged[id] = true; });
    return { flagged: flagged, updatedAt: '' };
  }

  // Old flat format: every key that is not a meta key and has a truthy value
  if (raw && typeof raw === 'object') {
    var flagged = {};
    Object.keys(raw).forEach(function(k) {
      if (k === 'updatedAt') return;
      if (raw[k] === true || raw[k] === 1 || raw[k] === '1') {
        flagged[k] = true;
      }
    });
    return { flagged: flagged, updatedAt: raw.updatedAt || '' };
  }

  return { flagged: {}, updatedAt: '' };
}

// ── Normalise: notifications ───────────────────────────────────────────────

function normaliseNotifs(raw) {
  if (Array.isArray(raw))                         return { notifications: raw };
  if (raw && Array.isArray(raw.notifications))    return raw;
  return { notifications: [] };
}

// ── File loaders ───────────────────────────────────────────────────────────

async function loadComments() {
  const r = await getFile(PATH_COMMENTS, { comments: [] });
  r.content = normaliseComments(r.content);
  return r;
}

async function loadNotifs() {
  const r = await getFile(PATH_NOTIFS, { notifications: [] });
  r.content = normaliseNotifs(r.content);
  return r;
}

async function loadFlags() {
  const r = await getFile(PATH_FLAGS, { flagged: {}, updatedAt: '' });
  r.content = normaliseFlags(r.content);
  return r;
}

// ── Utility ────────────────────────────────────────────────────────────────

function normText(s) { return String(s || '').trim(); }
function nowIso()    { return new Date().toISOString(); }

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
}

// ── Handler ────────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REPO || !GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GitHub not configured' });
  }

  try {

    // ════════════════════════════════════════════════════════════════════════
    // GET
    // ════════════════════════════════════════════════════════════════════════
    if (req.method === 'GET') {
      const q           = req.query || {};
      const user        = normText(q.user);
      const taskId      = normText(q.taskId);
      const allComments = q.allComments === '1';
      const allFlags    = q.allFlags    === '1';

      // ── Notifications for a user ─────────────────────────────────────────
      if (user) {
        const { content } = await loadNotifs();
        const list = content.notifications
          .filter(function(n) { return n.forUser === user; })
          .sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
        return res.status(200).json(list);
      }

      // ── Bulk: all comments ───────────────────────────────────────────────
      if (allComments) {
        const { content } = await loadComments();
        return res.status(200).json(content.comments);
      }

      // ── Bulk: all flags ──────────────────────────────────────────────────
      if (allFlags) {
        const { content } = await loadFlags();
        return res.status(200).json(content);
      }

      // ── Single task: comments + flag state ───────────────────────────────
      if (taskId) {
        const [commentsRes, flagsRes] = await Promise.all([loadComments(), loadFlags()]);
        const comments = commentsRes.content.comments
          .filter(function(c) { return c.taskId === taskId; })
          .sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
        const flagged = !!flagsRes.content.flagged[taskId];
        return res.status(200).json({ taskId, comments, flagged });
      }

      return res.status(400).json({
        error: 'Provide one of: user, taskId, allComments=1, allFlags=1'
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // POST
    // ════════════════════════════════════════════════════════════════════════
    if (req.method === 'POST') {
      const body   = parseBody(req);
      const action = normText(body.action).toLowerCase();

      // ── Add comment ──────────────────────────────────────────────────────
      if (action === 'comment') {
        const taskId = normText(body.taskId);
        const text   = normText(body.text);
        const author = normText(body.author) || 'Unknown';

        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        if (!text)   return res.status(400).json({ error: 'text is required' });

        const commentsRes = await loadComments();

        const comment = {
          id:        crypto.randomUUID(),
          taskId:    taskId,
          text:      text,
          author:    author,
          timestamp: nowIso()
        };

        commentsRes.content.comments.push(comment);

        // Cap at 2000 total comments
        if (commentsRes.content.comments.length > 2000) {
          commentsRes.content.comments = commentsRes.content.comments.slice(-2000);
        }

        // Write back in new normalised format — this migrates the file
        // permanently from the old keyed format to the new flat array format
        await putFile(PATH_COMMENTS, commentsRes.content, commentsRes.sha, 'Add task comment');
        return res.status(201).json({ ok: true, comment });
      }

      // ── Create notification ──────────────────────────────────────────────
      if (action === 'notify') {
        const forUser     = normText(body.forUser);
        const fromUser    = normText(body.fromUser)    || 'Someone';
        const taskId      = normText(body.taskId);
        const taskName    = normText(body.taskName)    || 'Task';
        const commentText = normText(body.commentText);

        if (!forUser) return res.status(400).json({ error: 'forUser is required' });
        if (!taskId)  return res.status(400).json({ error: 'taskId is required' });

        const notifsRes     = await loadNotifs();
        const notifications = notifsRes.content.notifications;

        // Deduplicate within 60 seconds
        const recentCutoff = Date.now() - 60000;
        const duplicate = notifications.some(function(n) {
          return n.forUser  === forUser
              && n.fromUser === fromUser
              && n.taskId   === taskId
              && new Date(n.timestamp).getTime() > recentCutoff;
        });
        if (duplicate) return res.status(200).json({ ok: true, duplicate: true });

        const notification = {
          id:          crypto.randomUUID(),
          forUser,
          fromUser,
          taskId,
          taskName,
          commentText,
          timestamp:   nowIso()
        };

        notifications.push(notification);

        // Cap at 500 total notifications
        if (notifications.length > 500) {
          notifsRes.content.notifications = notifications.slice(-500);
        }

        await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Add notification');
        return res.status(201).json({ ok: true, notification });
      }

      // ── Save flag ────────────────────────────────────────────────────────
      if (action === 'flag') {
        const taskId  = normText(body.taskId);
        const flagged = !!body.flagged;

        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const flagsRes = await loadFlags();
        const flags    = flagsRes.content;

        if (flagged) flags.flagged[taskId] = true;
        else         delete flags.flagged[taskId];

        flags.updatedAt = nowIso();

        await putFile(PATH_FLAGS, flags, flagsRes.sha, 'Update flagged tasks');
        return res.status(200).json({ ok: true, flagged: !!flags.flagged[taskId] });
      }

      return res.status(400).json({ error: 'Invalid action. Use: comment, notify, flag' });
    }

    // ════════════════════════════════════════════════════════════════════════
    // DELETE
    // ════════════════════════════════════════════════════════════════════════
    if (req.method === 'DELETE') {
      const body   = parseBody(req);
      const action = normText(body.action).toLowerCase();

      // ── Delete comment ───────────────────────────────────────────────────
      if (action === 'comment') {
        const taskId    = normText(body.taskId);
        const commentId = normText(body.commentId);

        if (!taskId)    return res.status(400).json({ error: 'taskId is required' });
        if (!commentId) return res.status(400).json({ error: 'commentId is required' });

        const commentsRes = await loadComments();
        const before      = commentsRes.content.comments.length;

        commentsRes.content.comments = commentsRes.content.comments.filter(function(c) {
          return !(c.taskId === taskId && c.id === commentId);
        });

        if (commentsRes.content.comments.length === before) {
          return res.status(404).json({ error: 'Comment not found' });
        }

        await putFile(PATH_COMMENTS, commentsRes.content, commentsRes.sha, 'Delete task comment');
        return res.status(200).json({ ok: true });
      }

      // ── Dismiss notification ─────────────────────────────────────────────
      if (action === 'notify') {

        // Clear all for a user
        if (body.clearAll === true) {
          const user = normText(body.user);
          if (!user) return res.status(400).json({ error: 'user is required for clearAll' });

          const notifsRes = await loadNotifs();
          const before    = notifsRes.content.notifications.length;

          notifsRes.content.notifications = notifsRes.content.notifications.filter(function(n) {
            return n.forUser !== user;
          });

          const removed = before - notifsRes.content.notifications.length;
          await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Clear all notifications for ' + user);
          return res.status(200).json({ ok: true, removed });
        }

        // Dismiss single
        const id = normText(body.id);
        if (!id) return res.status(400).json({ error: 'id is required' });

        const notifsRes = await loadNotifs();
        const before    = notifsRes.content.notifications.length;

        notifsRes.content.notifications = notifsRes.content.notifications.filter(function(n) {
          return n.id !== id;
        });

        if (notifsRes.content.notifications.length === before) {
          return res.status(404).json({ error: 'Notification not found' });
        }

        await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Dismiss notification');
        return res.status(200).json({ ok: true });
      }

      // ── Remove flag ──────────────────────────────────────────────────────
      if (action === 'flag') {
        const taskId = normText(body.taskId);
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const flagsRes = await loadFlags();
        const flags    = flagsRes.content;

        if (!flags.flagged[taskId]) {
          return res.status(404).json({ error: 'Flag not found' });
        }

        delete flags.flagged[taskId];
        flags.updatedAt = nowIso();

        await putFile(PATH_FLAGS, flags, flagsRes.sha, 'Remove flagged task');
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Invalid action. Use: comment, notify, flag' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

handler.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
module.exports = handler;
