// api/parts.js
// Stores part checkbox states in data/parts.json on GitHub
// Structure: { "[clientUuid]__[materialName]": { ordered: bool, received: bool, poNumber: string, updatedAt, updatedBy } }
//
// GET    /api/parts  → entire map
// POST   /api/parts  → body: { key, field, value, poNumber?, received?, updatedBy }
// DELETE /api/parts  → body: { key }

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/parts.json';

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
  if (res.status === 404) return { content: {}, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

async function putFile(content, sha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = { message: 'Update parts', content: encoded, branch: BRANCH };
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

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      return res.status(200).json(content);
    } catch(e) {
      console.log('[parts] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const key       = String(body.key       || '').trim();
      const field     = String(body.field     || '').trim();
      const value     = !!body.value;
      const poNumber  = body.poNumber !== undefined ? String(body.poNumber).trim() : null;
      const received  = body.received !== undefined ? !!body.received : null;
      const updatedBy = String(body.updatedBy || 'Unknown').trim();

      if (!key) return res.status(400).json({ error: 'key is required' });
      if (field !== 'ordered' && field !== 'received') {
        return res.status(400).json({ error: 'field must be ordered or received' });
      }

      console.log('[parts] POST key:', key, 'field:', field, 'value:', value, 'poNumber:', poNumber);

      const { content, sha } = await getFile();

      if (!content[key]) content[key] = { ordered: false, received: false, poNumber: '' };

      content[key][field]    = value;
      content[key].updatedAt = new Date().toISOString();
      content[key].updatedBy = updatedBy;

      // Sync poNumber if provided
      if (poNumber !== null) content[key].poNumber = poNumber;

      // Sync received if provided alongside ordered
      if (received !== null) content[key].received = received;

      // If received, also mark ordered
      if (field === 'received' && value) content[key].ordered = true;

      // If un-ordering, also clear received and PO number
      if (field === 'ordered' && !value) {
        content[key].received = false;
        content[key].poNumber = '';
      }

      await putFile(content, sha);
      return res.status(200).json({ ok: true, state: content[key] });

    } catch(e) {
      console.log('[parts] POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const key = String(body.key || '').trim();
      if (!key) return res.status(400).json({ error: 'key is required' });

      const { content, sha } = await getFile();
      delete content[key];
      await putFile(content, sha);
      return res.status(200).json({ ok: true });

    } catch(e) {
      console.log('[parts] DELETE error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
module.exports = handler;
