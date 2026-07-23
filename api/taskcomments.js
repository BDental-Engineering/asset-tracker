// api/taskcomments.js
// Stores comments keyed by task ID in data/taskcomments.json on GitHub
// GET  /api/taskcomments?taskId=xxx  → returns array of comments for that task
// POST /api/taskcomments             → body: { taskId, text, author }  → appends comment

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/taskcomments.json';

// ── GitHub helpers ────────────────────────────────────────────────────────────
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
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFile() {
  const res = await githubRequest(
    'GET',
    '/repos/' + REPO + '/contents/' + PATH + '?ref=' + BRANCH
  );
  if (res.status === 404) return { content: {}, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(
    Buffer.from(res.body.content, 'base64').toString('utf8')
  );
  return { content, sha: res.body.sha };
}

async function putFile(content, sha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = {
    message: 'Update task comments',
    content: encoded,
    branch:  BRANCH
  };
  if (sha) payload.sha = sha;
  const res = await githubRequest(
    'PUT',
    '/repos/' + REPO + '/contents/' + PATH,
    payload
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res;
}

// ── Handler ───────────────────────────────────────────────────────────────────
const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REPO || !GITHUB_TOKEN) {
    console.log('[taskcomments] missing env vars — REPO:', REPO, 'TOKEN set:', !!GITHUB_TOKEN);
    return res.status(500).json({ error: 'GitHub not configured' });
  }

  // ── GET ───────────────────────────────────────────────────────────────────
  // /api/taskcomments?taskId=xxx  → returns [] or array of comment objects
  if (req.method === 'GET') {
    try {
      const taskId = (req.query && req.query.taskId) || null;
      const { content } = await getFile();
      console.log('[taskcomments] GET taskId:', taskId);
      if (taskId) {
        return res.status(200).json(content[taskId] || []);
      }
      // No taskId → return entire map (useful for bulk pre-load)
      return res.status(200).json(content);
    } catch (e) {
      console.log('[taskcomments] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  // body: { taskId: string, text: string, author: string }
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

      const taskId = String(body.taskId || '').trim();
      const text   = String(body.text   || '').trim();
      const author = String(body.author || 'Unknown').trim();

      if (!taskId) return res.status(400).json({ error: 'taskId is required' });
      if (!text)   return res.status(400).json({ error: 'text is required' });

      console.log('[taskcomments] POST taskId:', taskId, 'author:', author);

      const { content, sha } = await getFile();

      if (!Array.isArray(content[taskId])) content[taskId] = [];

      const comment = {
        id:        Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        taskId:    taskId,
        text:      text,
        author:    author,
        timestamp: new Date().toISOString()
      };

      content[taskId].push(comment);

      await putFile(content, sha);

      console.log('[taskcomments] saved comment', comment.id, 'for task', taskId);
      return res.status(200).json({ ok: true, comment });

    } catch (e) {
      console.log('[taskcomments] POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  // body: { taskId: string, commentId: string }
  if (req.method === 'DELETE') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

      const taskId    = String(body.taskId    || '').trim();
      const commentId = String(body.commentId || '').trim();

      if (!taskId || !commentId) {
        return res.status(400).json({ error: 'taskId and commentId are required' });
      }

      console.log('[taskcomments] DELETE commentId:', commentId, 'from task:', taskId);

      const { content, sha } = await getFile();

      if (!Array.isArray(content[taskId])) {
        return res.status(404).json({ error: 'No comments for this task' });
      }

      const before = content[taskId].length;
      content[taskId] = content[taskId].filter(function(c) {
        return c.id !== commentId;
      });

      if (content[taskId].length === before) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      // Clean up empty arrays to keep the file tidy
      if (content[taskId].length === 0) delete content[taskId];

      await putFile(content, sha);

      console.log('[taskcomments] deleted comment', commentId);
      return res.status(200).json({ ok: true });

    } catch (e) {
      console.log('[taskcomments] DELETE error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

module.exports = handler;
