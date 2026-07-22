const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/flaggedtasks.json';

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
  const res = await githubRequest('GET', '/repos/' + REPO + '/contents/' + PATH + '?ref=' + BRANCH);
  if (res.status === 404) return { content: {}, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REPO || !GITHUB_TOKEN) {
    console.log('[flaggedtasks] missing env vars — REPO:', REPO, 'TOKEN set:', !!GITHUB_TOKEN);
    return res.status(500).json({ error: 'GitHub not configured' });
  }

  // ── GET ────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      const count = Object.keys(content).length;
      console.log('[flaggedtasks] GET returning', count, 'flagged IDs');
      return res.status(200).json(content);
    } catch (e) {
      console.log('[flaggedtasks] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ───────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      console.log('[flaggedtasks] POST hit');
      console.log('[flaggedtasks] req.body type:', typeof req.body);
      console.log('[flaggedtasks] req.body raw:', JSON.stringify(req.body).substring(0, 300));

      // Vercel pre-parses JSON bodies — handle object, string, or missing
      let incoming = req.body;

      if (typeof incoming === 'string') {
        try { incoming = JSON.parse(incoming); }
        catch(e) {
          console.log('[flaggedtasks] failed to parse string body:', e.message);
          incoming = {};
        }
      }

      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        console.log('[flaggedtasks] body was not a plain object, defaulting to {}');
        incoming = {};
      }

      // Sanitise — keep only keys whose value is strictly true
      const cleaned = {};
      Object.keys(incoming).forEach(function(k) {
        if (incoming[k] === true) cleaned[k] = true;
      });

      const count = Object.keys(cleaned).length;
      console.log('[flaggedtasks] sanitised to', count, 'flagged IDs');

      // Read current SHA so GitHub lets us overwrite the file
      const { sha } = await getFile();
      console.log('[flaggedtasks] current file sha:', sha);

      const encoded = Buffer.from(JSON.stringify(cleaned, null, 2)).toString('base64');

      const pushPayload = {
        message: 'Update flagged tasks',
        content: encoded,
        branch:  BRANCH
      };
      if (sha) pushPayload.sha = sha;

      const pushRes = await githubRequest(
        'PUT',
        '/repos/' + REPO + '/contents/' + PATH,
        pushPayload
      );

      console.log('[flaggedtasks] GitHub PUT status:', pushRes.status);

      if (pushRes.status !== 200 && pushRes.status !== 201) {
        throw new Error('GitHub write failed: ' + pushRes.status + ' ' + JSON.stringify(pushRes.body));
      }

      console.log('[flaggedtasks] successfully saved', count, 'flagged IDs to GitHub');
      return res.status(200).json({ ok: true, count });

    } catch (e) {
      console.log('[flaggedtasks] POST error:', e.message);
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
