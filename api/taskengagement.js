// api/taskengagement.js
// Combined endpoint for task comments, notifications, flagged task state,
// and the client-side notification bell script.
//
// GET  /api/taskengagement?bellScript=1     → serves notif-bell.js
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

const https  = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';

const PATH_COMMENTS = 'data/taskcomments.json';
const PATH_NOTIFS   = 'data/notifications.json';
const PATH_FLAGS    = 'data/flaggedtasks.json';

// ══════════════════════════════════════════════════════════════════════════
// BELL SCRIPT — served as JS to any page that includes it
// ══════════════════════════════════════════════════════════════════════════

const BELL_SCRIPT = `
(function () {
  'use strict';

  var ENGAGEMENT_API = '/api/taskengagement';
  var POLL_INTERVAL  = 30000;

  var currentUser   = '';
  var notifications = [];
  var pollTimer     = null;

  function getUser() {
    var name = '';
    document.cookie.split(';').forEach(function (c) {
      var p = c.trim().split('=');
      if (p[0] === 'sm8_user_name') name = decodeURIComponent(p.slice(1).join('='));
    });
    return name;
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDateTime(str) {
    if (!str) return '';
    var d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  }

  function injectStyles() {
    if (document.getElementById('nb-style')) return;
    var s = document.createElement('style');
    s.id = 'nb-style';
    s.textContent = [
      '.nb-btn{position:relative;display:inline-flex;align-items:center;gap:6px;',
      'background:var(--surface2,#22263a);border:1px solid var(--border,#2e3350);',
      'border-radius:8px;padding:7px 14px;font-size:0.85rem;font-weight:600;',
      'color:var(--text,#e2e8f0);cursor:pointer;transition:border-color 0.15s;',
      'font-family:inherit;line-height:1;}',
      '.nb-btn:hover{border-color:var(--accent,#4f6ef7);}',
      '.nb-badge{position:absolute;top:-6px;right:-6px;background:#ef4444;color:#fff;',
      'border-radius:10px;padding:1px 6px;font-size:0.65rem;font-weight:800;',
      'min-width:18px;text-align:center;line-height:16px;display:none;}',
      '.nb-badge.show{display:block;}',
      '.nb-drop{display:none;position:fixed;top:64px;right:20px;',
      'background:var(--surface,#1a1d27);border:1px solid var(--border,#2e3350);',
      'border-radius:14px;width:360px;max-height:480px;overflow-y:auto;',
      'z-index:9000;box-shadow:0 8px 32px rgba(0,0,0,0.4);}',
      '.nb-drop.open{display:block;}',
      '.nb-header{display:flex;align-items:center;justify-content:space-between;',
      'padding:12px 16px;border-bottom:1px solid var(--border,#2e3350);',
      'font-weight:700;font-size:0.88rem;position:sticky;top:0;',
      'background:var(--surface,#1a1d27);z-index:1;}',
      '.nb-clear{font-size:0.72rem;color:#8892b0;background:none;border:none;',
      'cursor:pointer;padding:2px 6px;border-radius:4px;font-weight:600;font-family:inherit;}',
      '.nb-clear:hover{color:#ef4444;background:rgba(239,68,68,0.1);}',
      '.nb-empty{padding:24px;text-align:center;color:#8892b0;font-size:0.85rem;}',
      '.nb-item{display:flex;gap:10px;padding:12px 16px;',
      'border-bottom:1px solid var(--border,#2e3350);',
      'cursor:pointer;transition:background 0.15s;align-items:flex-start;}',
      '.nb-item:hover{background:rgba(79,110,247,0.06);}',
      '.nb-item:last-child{border-bottom:none;}',
      '.nb-icon{font-size:1.1rem;flex-shrink:0;margin-top:1px;}',
      '.nb-body{flex:1;min-width:0;}',
      '.nb-task{font-weight:700;font-size:0.82rem;color:var(--text,#e2e8f0);',
      'margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.nb-msg{font-size:0.75rem;color:#8892b0;line-height:1.4;}',
      '.nb-time{font-size:0.65rem;color:#8892b0;margin-top:4px;}',
      '.nb-dismiss{background:none;border:none;color:#8892b0;cursor:pointer;',
      'font-size:0.75rem;padding:2px 5px;border-radius:4px;flex-shrink:0;',
      'font-family:inherit;}',
      '.nb-dismiss:hover{color:#ef4444;background:rgba(239,68,68,0.1);}'
    ].join('');
    document.head.appendChild(s);
  }

  function buildDOM(container) {
    injectStyles();

    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block;';

    var btn = document.createElement('button');
    btn.className = 'nb-btn';
    btn.id        = 'nb-btn';
    btn.innerHTML = '&#128276;<span class="nb-badge" id="nb-badge"></span>';
    btn.onclick   = function (e) { e.stopPropagation(); toggleDrop(); };

    var drop = document.createElement('div');
    drop.className = 'nb-drop';
    drop.id        = 'nb-drop';
    drop.innerHTML =
      '<div class="nb-header">&#128276; Notifications'
      + '<button class="nb-clear" id="nb-clear">Clear all</button></div>'
      + '<div id="nb-list"><div class="nb-empty">No notifications</div></div>';

    wrap.appendChild(btn);
    document.body.appendChild(drop);
    container.appendChild(wrap);

    document.getElementById('nb-clear').onclick = clearAll;

    document.addEventListener('click', function (e) {
      var d = document.getElementById('nb-drop');
      if (d && d.classList.contains('open')) {
        if (!d.contains(e.target) && e.target.id !== 'nb-btn') {
          d.classList.remove('open');
        }
      }
    });
  }

  function toggleDrop() {
    var d = document.getElementById('nb-drop');
    if (d) d.classList.toggle('open');
  }

  function loadNotifications() {
    if (!currentUser) return;
    fetch(ENGAGEMENT_API + '?user=' + encodeURIComponent(currentUser), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) {
        notifications = Array.isArray(d) ? d : [];
        renderBadge();
        renderList();
      })
      .catch(function () { notifications = []; });
  }

  function renderBadge() {
    var badge = document.getElementById('nb-badge');
    if (!badge) return;
    var count = notifications.length;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('show', count > 0);
  }

  function renderList() {
    var el = document.getElementById('nb-list');
    if (!el) return;
    if (!notifications.length) {
      el.innerHTML = '<div class="nb-empty">&#10003; All caught up!</div>';
      return;
    }
    el.innerHTML = notifications.map(function (n) {
      return '<div class="nb-item" onclick="nbOpen(\'' + esc(n.id) + '\',\'' + esc(n.taskId) + '\')">'
        + '<span class="nb-icon">&#128172;</span>'
        + '<div class="nb-body">'
        +   '<div class="nb-task">' + esc(n.taskName || 'Task') + '</div>'
        +   '<div class="nb-msg"><strong>' + esc(n.fromUser || '') + '</strong> commented: &ldquo;'
        +     esc((n.commentText || '').substring(0, 80))
        +     (n.commentText && n.commentText.length > 80 ? '&hellip;' : '')
        +   '&rdquo;</div>'
        +   '<div class="nb-time">&#128336; ' + fmtDateTime(n.timestamp) + '</div>'
        + '</div>'
        + '<button class="nb-dismiss" onclick="nbDismiss(event,\'' + esc(n.id) + '\')">&#10005;</button>'
        + '</div>';
    }).join('');
  }

  window.nbDismiss = function (e, id) {
    if (e) e.stopPropagation();
    fetch(ENGAGEMENT_API, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', id: id })
    }).then(function () {
      notifications = notifications.filter(function (n) { return n.id !== id; });
      renderBadge();
      renderList();
    }).catch(function () {});
  };

  window.nbOpen = function (notifId, taskId) {
    var d = document.getElementById('nb-drop');
    if (d) d.classList.remove('open');
    fetch(ENGAGEMENT_API, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', id: notifId })
    }).catch(function () {});
    window.location.href = 'tasks.html#task=' + encodeURIComponent(taskId);
  };

  function clearAll() {
    if (!currentUser) return;
    fetch(ENGAGEMENT_API, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', clearAll: true, user: currentUser })
    }).then(function () {
      notifications = [];
      renderBadge();
      renderList();
      var d = document.getElementById('nb-drop');
      if (d) d.classList.remove('open');
    }).catch(function () {});
  }

  function init() {
    currentUser = getUser();
    if (!currentUser) return;

    var mount = document.getElementById('notif-bell-mount')
             || document.querySelector('.header-right');
    if (!mount) return;

    buildDOM(mount);
    loadNotifications();
    pollTimer = setInterval(loadNotifications, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

// ══════════════════════════════════════════════════════════════════════════
// GITHUB HELPERS
// ══════════════════════════════════════════════════════════════════════════

function githubRequest(method, endpoint, body) {
  return new Promise(function (resolve, reject) {
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
    const req = https.request(options, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
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

// ══════════════════════════════════════════════════════════════════════════
// NORMALISE HELPERS
// ══════════════════════════════════════════════════════════════════════════

function normaliseComments(raw) {
  var merged = [];
  var seenIds = {};

  function addComment(c) {
    if (!c || typeof c !== 'object') return;
    var id = c.id || '';
    if (id && seenIds[id]) return;
    if (id) seenIds[id] = true;
    merged.push(c);
  }

  if (Array.isArray(raw)) {
    raw.forEach(addComment);
    return { comments: merged };
  }

  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (key) {
      var val = raw[key];
      if (key === 'comments' && Array.isArray(val)) {
        val.forEach(addComment);
        return;
      }
      if (Array.isArray(val)) {
        val.forEach(function (c) {
          if (c && typeof c === 'object') {
            if (!c.taskId) c.taskId = key;
            addComment(c);
          }
        });
      }
    });
  }

  merged.sort(function (a, b) {
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });

  return { comments: merged };
}

function normaliseFlags(raw) {
  if (!raw || typeof raw !== 'object') return { flagged: {}, updatedAt: '' };

  if (Array.isArray(raw)) {
    var flagged = {};
    raw.forEach(function (id) { if (typeof id === 'string') flagged[id] = true; });
    return { flagged: flagged, updatedAt: '' };
  }

  var flagged = {};

  if (raw.flagged && typeof raw.flagged === 'object' && !Array.isArray(raw.flagged)) {
    Object.keys(raw.flagged).forEach(function (k) {
      if (raw.flagged[k] === true || raw.flagged[k] === 1 || raw.flagged[k] === '1') {
        flagged[k] = true;
      }
    });
  }

  var META_KEYS = { flagged: true, updatedAt: true };
  Object.keys(raw).forEach(function (k) {
    if (META_KEYS[k]) return;
    if (raw[k] === true || raw[k] === 1 || raw[k] === '1') {
      flagged[k] = true;
    }
  });

  return { flagged: flagged, updatedAt: raw.updatedAt || '' };
}

function normaliseNotifs(raw) {
  if (Array.isArray(raw))                      return { notifications: raw };
  if (raw && Array.isArray(raw.notifications)) return raw;
  return { notifications: [] };
}

// ══════════════════════════════════════════════════════════════════════════
// FILE LOADERS
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════════════

function normText(s) { return String(s || '').trim(); }
function nowIso()    { return new Date().toISOString(); }

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Serve the bell script ──────────────────────────────────────────────
  if (req.method === 'GET' && (req.query || {}).bellScript === '1') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    return res.status(200).send(BELL_SCRIPT);
  }

  if (!REPO || !GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GitHub not configured' });
  }

  try {

    // ══════════════════════════════════════════════════════════════════════
    // GET
    // ══════════════════════════════════════════════════════════════════════
    if (req.method === 'GET') {
      const q           = req.query || {};
      const user        = normText(q.user);
      const taskId      = normText(q.taskId);
      const allComments = q.allComments === '1';
      const allFlags    = q.allFlags    === '1';

      if (user) {
        const { content } = await loadNotifs();
        const list = content.notifications
          .filter(function (n) { return n.forUser === user; })
          .sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
        return res.status(200).json(list);
      }

      if (allComments) {
        const { content } = await loadComments();
        return res.status(200).json(content.comments);
      }

      if (allFlags) {
        const { content } = await loadFlags();
        return res.status(200).json(content);
      }

      if (taskId) {
        const [commentsRes, flagsRes] = await Promise.all([loadComments(), loadFlags()]);
        const comments = commentsRes.content.comments
          .filter(function (c) { return c.taskId === taskId; })
          .sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
        const flagged = !!flagsRes.content.flagged[taskId];
        return res.status(200).json({ taskId, comments, flagged });
      }

      return res.status(400).json({
        error: 'Provide one of: bellScript=1, user, taskId, allComments=1, allFlags=1'
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // POST
    // ══════════════════════════════════════════════════════════════════════
    if (req.method === 'POST') {
      const body   = parseBody(req);
      const action = normText(body.action).toLowerCase();

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
        if (commentsRes.content.comments.length > 2000) {
          commentsRes.content.comments = commentsRes.content.comments.slice(-2000);
        }
        await putFile(PATH_COMMENTS, commentsRes.content, commentsRes.sha, 'Add task comment');
        return res.status(201).json({ ok: true, comment });
      }

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
        const recentCutoff  = Date.now() - 60000;
        const duplicate = notifications.some(function (n) {
          return n.forUser  === forUser
              && n.fromUser === fromUser
              && n.taskId   === taskId
              && new Date(n.timestamp).getTime() > recentCutoff;
        });
        if (duplicate) return res.status(200).json({ ok: true, duplicate: true });

        const notification = {
          id: crypto.randomUUID(),
          forUser, fromUser, taskId, taskName, commentText,
          timestamp: nowIso()
        };
        notifications.push(notification);
        if (notifications.length > 500) {
          notifsRes.content.notifications = notifications.slice(-500);
        }
        await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Add notification');
        return res.status(201).json({ ok: true, notification });
      }

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

    // ══════════════════════════════════════════════════════════════════════
    // DELETE
    // ══════════════════════════════════════════════════════════════════════
    if (req.method === 'DELETE') {
      const body   = parseBody(req);
      const action = normText(body.action).toLowerCase();

      if (action === 'comment') {
        const taskId    = normText(body.taskId);
        const commentId = normText(body.commentId);
        if (!taskId)    return res.status(400).json({ error: 'taskId is required' });
        if (!commentId) return res.status(400).json({ error: 'commentId is required' });

        const commentsRes = await loadComments();
        const before      = commentsRes.content.comments.length;
        commentsRes.content.comments = commentsRes.content.comments.filter(function (c) {
          return !(c.taskId === taskId && c.id === commentId);
        });
        if (commentsRes.content.comments.length === before) {
          return res.status(404).json({ error: 'Comment not found' });
        }
        await putFile(PATH_COMMENTS, commentsRes.content, commentsRes.sha, 'Delete task comment');
        return res.status(200).json({ ok: true });
      }

      if (action === 'notify') {
        if (body.clearAll === true) {
          const user = normText(body.user);
          if (!user) return res.status(400).json({ error: 'user is required for clearAll' });
          const notifsRes = await loadNotifs();
          const before    = notifsRes.content.notifications.length;
          notifsRes.content.notifications = notifsRes.content.notifications.filter(function (n) {
            return n.forUser !== user;
          });
          const removed = before - notifsRes.content.notifications.length;
          await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Clear all notifications for ' + user);
          return res.status(200).json({ ok: true, removed });
        }

        const id = normText(body.id);
        if (!id) return res.status(400).json({ error: 'id is required' });
        const notifsRes = await loadNotifs();
        const before    = notifsRes.content.notifications.length;
        notifsRes.content.notifications = notifsRes.content.notifications.filter(function (n) {
          return n.id !== id;
        });
        if (notifsRes.content.notifications.length === before) {
          return res.status(404).json({ error: 'Notification not found' });
        }
        await putFile(PATH_NOTIFS, notifsRes.content, notifsRes.sha, 'Dismiss notification');
        return res.status(200).json({ ok: true });
      }

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
