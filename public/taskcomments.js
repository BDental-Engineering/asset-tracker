// taskcomments.js  — client side
// Attach to tasks.html via <script src="taskcomments.js"></script>

(function() {

  // ── Config ──────────────────────────────────────────────────────────────────
  var API = '/api/taskcomments';

  // ── Inject stylesheet ───────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.tc-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(79,110,247,0.12);border:1px solid rgba(79,110,247,0.3);border-radius:8px;padding:4px 10px;font-size:0.75rem;font-weight:600;color:#4f6ef7;cursor:pointer;transition:background 0.15s;}',
    '.tc-btn:hover{background:rgba(79,110,247,0.25);}',
    '.tc-btn .tc-count{background:#4f6ef7;color:#fff;border-radius:10px;padding:1px 6px;font-size:0.68rem;margin-left:2px;}',
    '.tc-panel{display:none;margin-top:10px;background:#1a1d27;border:1px solid #2e3350;border-radius:10px;padding:14px;flex-direction:column;gap:10px;}',
    '.tc-panel.open{display:flex;}',
    '.tc-list{display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;}',
    '.tc-item{background:#22263a;border:1px solid #2e3350;border-radius:8px;padding:10px 12px;position:relative;}',
    '.tc-item-author{font-size:0.72rem;font-weight:700;color:#4f6ef7;margin-bottom:3px;}',
    '.tc-item-text{font-size:0.82rem;color:#e2e8f0;line-height:1.5;white-space:pre-wrap;word-break:break-word;}',
    '.tc-item-time{font-size:0.65rem;color:#8892b0;margin-top:5px;}',
    '.tc-item-del{position:absolute;top:7px;right:8px;background:none;border:none;color:#8892b0;cursor:pointer;font-size:0.75rem;padding:2px 5px;border-radius:4px;line-height:1;}',
    '.tc-item-del:hover{color:#ef4444;background:rgba(239,68,68,0.1);}',
    '.tc-empty{font-size:0.8rem;color:#8892b0;text-align:center;padding:10px 0;}',
    '.tc-compose{display:flex;flex-direction:column;gap:6px;border-top:1px solid #2e3350;padding-top:10px;}',
    '.tc-textarea{background:#0f1117;border:1px solid #2e3350;border-radius:8px;padding:8px 10px;color:#e2e8f0;font-size:0.82rem;resize:vertical;min-height:64px;outline:none;font-family:inherit;width:100%;box-sizing:border-box;}',
    '.tc-textarea:focus{border-color:#4f6ef7;}',
    '.tc-compose-row{display:flex;gap:8px;align-items:center;}',
    '.tc-submit{background:#4f6ef7;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:0.82rem;font-weight:700;cursor:pointer;transition:opacity 0.15s;}',
    '.tc-submit:hover{opacity:0.85;}',
    '.tc-submit:disabled{opacity:0.5;cursor:not-allowed;}',
    '.tc-status{font-size:0.75rem;color:#8892b0;}'
  ].join('');
  document.head.appendChild(style);

  // ── In-memory cache: taskId → comment[] ────────────────────────────────────
  var cache = {};

  // ── Public API ──────────────────────────────────────────────────────────────
  window.TaskComments = {

    // Call this once after tasks render to inject a comment button into each task row/card.
    // containerEl  : the DOM element that wraps all task rows
    // getTaskId    : function(rowEl) → string taskId
    // getTaskRowEl : optional — if your button goes inside a sub-element, supply a selector
    attachToRows: function(containerEl, getTaskId) {
      if (!containerEl) return;
      // Find all task rows — works for both table rows and card divs
      var rows = containerEl.querySelectorAll('[data-task-id]');
      rows.forEach(function(row) {
        var taskId = row.getAttribute('data-task-id');
        if (!taskId) return;
        // Avoid double-mounting
        if (row.querySelector('.tc-btn')) return;
        TaskComments.mountOnRow(row, taskId);
      });
    },

    // Mount button + panel on a single row element that has data-task-id
    mountOnRow: function(rowEl, taskId) {
      var author = TaskComments._getAuthor();

      // Button
      var btn = document.createElement('button');
      btn.className = 'tc-btn';
      btn.title = 'Comments';
      btn.innerHTML = '&#128172; Comments <span class="tc-count">…</span>';

      // Panel (hidden by default)
      var panel = document.createElement('div');
      panel.className = 'tc-panel';
      panel.innerHTML =
        '<div class="tc-list" id="tc-list-' + esc(taskId) + '"><div class="tc-empty">Loading…</div></div>' +
        '<div class="tc-compose">' +
        '<textarea class="tc-textarea" placeholder="Add a comment…" id="tc-ta-' + esc(taskId) + '"></textarea>' +
        '<div class="tc-compose-row">' +
        '<button class="tc-submit" id="tc-sub-' + esc(taskId) + '">Post</button>' +
        '<span class="tc-status" id="tc-st-' + esc(taskId) + '"></span>' +
        '</div></div>';

      // Toggle panel on button click
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var isOpen = panel.classList.contains('open');
        // Close all other open panels first
        document.querySelectorAll('.tc-panel.open').forEach(function(p) { p.classList.remove('open'); });
        if (!isOpen) {
          panel.classList.add('open');
          TaskComments._loadComments(taskId, btn);
        }
      });

      // Post button
      panel.querySelector('#tc-sub-' + taskId).addEventListener('click', function(e) {
        e.stopPropagation();
        var ta  = panel.querySelector('#tc-ta-' + taskId);
        var st  = panel.querySelector('#tc-st-' + taskId);
        var sub = panel.querySelector('#tc-sub-' + taskId);
        var text = (ta.value || '').trim();
        if (!text) { st.textContent = 'Please enter a comment.'; return; }
        sub.disabled = true;
        st.textContent = 'Saving…';
        TaskComments._postComment(taskId, text, author, function(err, comment) {
          sub.disabled = false;
          if (err) { st.textContent = 'Error: ' + err; return; }
          ta.value = '';
          st.textContent = '✓ Posted';
          setTimeout(function() { st.textContent = ''; }, 2500);
          // Append to local cache + re-render
          if (!cache[taskId]) cache[taskId] = [];
          cache[taskId].push(comment);
          TaskComments._renderList(taskId, btn);
        });
      });

      // Append into the row — try a dedicated actions cell, else append after row
      var actionsCell = rowEl.querySelector('.task-actions, .tc-actions, td:last-child');
      if (actionsCell) {
        actionsCell.appendChild(btn);
        actionsCell.appendChild(panel);
      } else {
        rowEl.appendChild(btn);
        rowEl.appendChild(panel);
      }

      // Pre-load count silently
      TaskComments._loadComments(taskId, btn, true);
    },

    // ── Internal ──────────────────────────────────────────────────────────────
    _getAuthor: function() {
      // Reuse the same identity cookie logic as index.html
      var name = '';
      document.cookie.split(';').forEach(function(c) {
        var p = c.trim().split('=');
        if (p[0] === 'sm8_user_name') name = decodeURIComponent(p.slice(1).join('='));
      });
      return name || localStorage.getItem('sm8_session_name') || 'Unknown';
    },

    _loadComments: function(taskId, btn, silentOnly) {
      // Use cache if available and not a forced refresh
      if (cache[taskId] && silentOnly) {
        TaskComments._renderList(taskId, btn);
        return;
      }
      fetch(API + '?taskId=' + encodeURIComponent(taskId), { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          cache[taskId] = Array.isArray(data) ? data : [];
          TaskComments._renderList(taskId, btn);
        })
        .catch(function(e) {
          console.warn('[taskcomments] load error', e);
          cache[taskId] = cache[taskId] || [];
          TaskComments._renderList(taskId, btn);
        });
    },

    _renderList: function(taskId, btn) {
      var comments = cache[taskId] || [];
      var count = comments.length;

      // Update badge on button
      var badge = btn.querySelector('.tc-count');
      if (badge) badge.textContent = count;

      var listEl = document.getElementById('tc-list-' + taskId);
      if (!listEl) return;

      if (!count) {
        listEl.innerHTML = '<div class="tc-empty">No comments yet.</div>';
        return;
      }

      listEl.innerHTML = comments.map(function(c) {
        return '<div class="tc-item" id="tc-c-' + esc(c.id) + '">' +
          '<div class="tc-item-author">&#128100; ' + esc(c.author || 'Unknown') + '</div>' +
          '<div class="tc-item-text">' + esc(c.text) + '</div>' +
          '<div class="tc-item-time">&#128336; ' + formatDateTime(c.timestamp) + '</div>' +
          '<button class="tc-item-del" title="Delete comment" ' +
            'onclick="TaskComments._deleteComment(\'' + esc(taskId) + '\',\'' + esc(c.id) + '\',this)">&#10005;</button>' +
          '</div>';
      }).join('');

      // Scroll to bottom so newest is visible
      listEl.scrollTop = listEl.scrollHeight;
    },

    _postComment: function(taskId, text, author, cb) {
      fetch(API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: taskId, text: text, author: author })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) { cb(data.error); return; }
          cb(null, data.comment);
        })
        .catch(function(e) { cb(e.message); });
    },

    _deleteComment: function(taskId, commentId, btnEl) {
      if (!confirm('Delete this comment?')) return;
      btnEl.disabled = true;
      fetch(API, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: taskId, commentId: commentId })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) { alert('Delete failed: ' + data.error); btnEl.disabled = false; return; }
          // Remove from cache
          if (cache[taskId]) {
            cache[taskId] = cache[taskId].filter(function(c) { return c.id !== commentId; });
          }
          var el = document.getElementById('tc-c-' + commentId);
          if (el) el.remove();
          // Update badge
          var panel = btnEl.closest('.tc-panel');
          if (panel) {
            var row = panel.parentElement;
            var badge = row && row.querySelector('.tc-count');
            if (badge) badge.textContent = (cache[taskId] || []).length;
          }
        })
        .catch(function(e) { alert('Delete failed: ' + e.message); btnEl.disabled = false; });
    }
  };

  // ── Tiny helpers ────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function formatDateTime(str) {
    if (!str) return '';
    var d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

})();
