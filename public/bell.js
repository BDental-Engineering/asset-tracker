// ─────────────────────────────────────────────────────────────────────────────
// bell.js  —  Shared notification bell for all Asset Tracker pages
// Reads from /api/taskengagement (GitHub-backed JSON storage)
// Mount point: <div id="notif-bell-mount"></div> in each page header
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  var POLL_INTERVAL_MS = 60000; // re-check every 60 s
  var MAX_NOTIFS       = 50;    // cap stored notifications

  // ── State ─────────────────────────────────────────────────────────────────
  var _notifications = [];   // [{id, taskId, taskTitle, message, icon, ts, read}]
  var _open          = false;
  var _pollTimer     = null;
  var _currentUser   = '';

  // ── Boot ──────────────────────────────────────────────────────────────────
  function initBell() {
    _currentUser = _readUserCookie();
    _injectHTML();
    _bindOutsideClick();
    nbLoad();
    _pollTimer = setInterval(nbLoad, POLL_INTERVAL_MS);

    // Deep-link: if URL has #task=UUID, open that task on tasks.html
    if (window.location.hash && window.location.hash.indexOf('#task=') === 0) {
      var uuid = window.location.hash.replace('#task=', '');
      if (uuid && window.openTaskDetail) {
        setTimeout(function () { window.openTaskDetail(uuid); }, 600);
      }
    }
  }

  // ── Inject bell HTML into mount div ───────────────────────────────────────
  function _injectHTML() {
    var mount = document.getElementById('notif-bell-mount');
    if (!mount) return;

    mount.innerHTML =
      '<button class="nb-btn" id="nb-btn" onclick="nbToggle()" aria-label="Notifications">' +
        '&#128276;' +
        '<span class="nb-badge" id="nb-badge"></span>' +
      '</button>';

    // Inject dropdown before </body> if not already present
    if (!document.getElementById('nb-drop')) {
      var drop = document.createElement('div');
      drop.className = 'nb-drop';
      drop.id        = 'nb-drop';
      drop.innerHTML =
        '<div class="nb-header">' +
          '<span>&#128276; Notifications</span>' +
          '<button class="nb-clear" onclick="nbClearAll()">Clear all</button>' +
        '</div>' +
        '<div id="nb-list"></div>';
      document.body.appendChild(drop);
    }
  }

  // ── Outside-click closes dropdown ─────────────────────────────────────────
  function _bindOutsideClick() {
    document.addEventListener('click', function (e) {
      if (!_open) return;
      var btn  = document.getElementById('nb-btn');
      var drop = document.getElementById('nb-drop');
      if (btn  && btn.contains(e.target))  return;
      if (drop && drop.contains(e.target)) return;
      _closeDropdown();
    });
  }

  // ── Load / poll ───────────────────────────────────────────────────────────
  function nbLoad() {
    fetch('/api/taskengagement?type=notifications', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        // data expected: { notifications: [...] }
        var incoming = Array.isArray(data.notifications) ? data.notifications : [];
        _mergeNotifications(incoming);
        nbRenderBadge();
        if (_open) nbRenderList();
      })
      .catch(function () {
        // silently fail — bell just won't update
      });
  }

  // Merge incoming server notifications with local state (preserve dismissals)
  function _mergeNotifications(incoming) {
    var existingIds = {};
    _notifications.forEach(function (n) { existingIds[n.id] = true; });

    incoming.forEach(function (n) {
      if (!n.id) return;
      // Only add if not already known (preserve local read/dismissed state)
      if (!existingIds[n.id]) {
        _notifications.unshift({
          id:        n.id,
          taskId:    n.taskId    || '',
          taskTitle: n.taskTitle || 'Task',
          message:   n.message   || '',
          icon:      n.icon      || '&#128276;',
          ts:        n.ts        || new Date().toISOString(),
          read:      false
        });
      }
    });

    // Cap list
    if (_notifications.length > MAX_NOTIFS) {
      _notifications = _notifications.slice(0, MAX_NOTIFS);
    }
  }

  // ── Badge ─────────────────────────────────────────────────────────────────
  function nbRenderBadge() {
    var badge = document.getElementById('nb-badge');
    if (!badge) return;
    var unread = _notifications.filter(function (n) { return !n.read; }).length;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.classList.add('show');
    } else {
      badge.textContent = '';
      badge.classList.remove('show');
    }
  }

  // ── Toggle dropdown ───────────────────────────────────────────────────────
  function nbToggle() {
    if (_open) { _closeDropdown(); } else { nbOpen(); }
  }

  function nbOpen() {
    _open = true;
    var drop = document.getElementById('nb-drop');
    if (drop) drop.classList.add('open');
    nbRenderList();
    // Mark all as read when opened
    _notifications.forEach(function (n) { n.read = true; });
    nbRenderBadge();
  }

  function _closeDropdown() {
    _open = false;
    var drop = document.getElementById('nb-drop');
    if (drop) drop.classList.remove('open');
  }

  // ── Render list ───────────────────────────────────────────────────────────
  function nbRenderList() {
    var list = document.getElementById('nb-list');
    if (!list) return;

    if (!_notifications.length) {
      list.innerHTML = '<div class="nb-empty">&#10003; All caught up!</div>';
      return;
    }

    list.innerHTML = _notifications.map(function (n) {
      return '<div class="nb-item" id="nbi-' + _esc(n.id) + '" onclick="nbItemClick(\'' + _esc(n.id) + '\')">' +
        '<div class="nb-icon">' + (n.icon || '&#128276;') + '</div>' +
        '<div class="nb-body">' +
          '<div class="nb-task">' + _esc(n.taskTitle) + '</div>' +
          '<div class="nb-msg">'  + _esc(n.message)   + '</div>' +
          '<div class="nb-time">' + nbFmtDateTime(n.ts) + '</div>' +
        '</div>' +
        '<button class="nb-dismiss" onclick="nbDismiss(event,\'' + _esc(n.id) + '\')">&#10005;</button>' +
      '</div>';
    }).join('');
  }

  // ── Item click — navigate to task ─────────────────────────────────────────
  function nbItemClick(id) {
    var n = _notifications.find(function (x) { return x.id === id; });
    if (!n || !n.taskId) return;

    var currentPage = window.location.pathname.split('/').pop() || 'index.html';

    if (currentPage === 'tasks.html') {
      _closeDropdown();
      if (window.openTaskDetail) {
        window.openTaskDetail(n.taskId);
      } else {
        window.location.hash = 'task=' + n.taskId;
      }
    } else {
      // Navigate to tasks.html with deep-link hash
      window.location.href = 'tasks.html#task=' + n.taskId;
    }
  }

  // ── Dismiss single ────────────────────────────────────────────────────────
  function nbDismiss(e, id) {
    e.stopPropagation();
    _notifications = _notifications.filter(function (n) { return n.id !== id; });
    nbRenderBadge();
    nbRenderList();
  }

  // ── Clear all ─────────────────────────────────────────────────────────────
  function nbClearAll() {
    _notifications = [];
    nbRenderBadge();
    nbRenderList();
  }

  // ── Date formatter ────────────────────────────────────────────────────────
  function nbFmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var now      = new Date();
    var diffMs   = now - d;
    var diffMins = Math.floor(diffMs / 60000);
    if (diffMins <  1)  return 'Just now';
    if (diffMins <  60) return diffMins + 'm ago';
    var diffHrs = Math.floor(diffMins / 60);
    if (diffHrs  <  24) return diffHrs + 'h ago';
    var diffDays = Math.floor(diffHrs / 24);
    if (diffDays <   7) return diffDays + 'd ago';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _readUserCookie() {
    var name = '';
    document.cookie.split(';').forEach(function (c) {
      var p = c.trim().split('=');
      if (p[0] === 'sm8_user_name') name = decodeURIComponent(p.slice(1).join('='));
    });
    return name || 'Unknown';
  }

  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Expose to global scope (called by onclick attributes) ─────────────────
  window.initBell      = initBell;
  window.nbLoad        = nbLoad;
  window.nbToggle      = nbToggle;
  window.nbOpen        = nbOpen;
  window.nbRenderBadge = nbRenderBadge;
  window.nbRenderList  = nbRenderList;
  window.nbItemClick   = nbItemClick;
  window.nbDismiss     = nbDismiss;
  window.nbClearAll    = nbClearAll;
  window.nbFmtDateTime = nbFmtDateTime;

})();
