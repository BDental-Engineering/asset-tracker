// api/materials-exclude.js
// Stores excluded item_numbers in data/materials-exclude.json on GitHub
// Structure: { excludedItemNumbers: ["ITEM001", "ITEM002", ...], updatedAt, updatedBy }
//
// GET    /api/materials-exclude  → returns the exclusion list
// POST   /api/materials-exclude  → body: { itemNumbers: [...], updatedBy }

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/materials-exclude.json';

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
  if (res.status === 404) return { content: { excludedItemNumbers: [] }, sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

async function putFile(content, sha) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const payload = { message: 'Update materials exclusion list', content: encoded, branch: BRANCH };
  if (sha) payload.sha = sha;
  const res = await githubRequest('PUT', '/repos/' + REPO + '/contents/' + PATH, payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res;
}

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REPO || !GITHUB_TOKEN) return res.status(500).json({ error: 'GitHub not configured' });

  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      return res.status(200).json(content);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const itemNumbers = Array.isArray(body.itemNumbers)
        ? body.itemNumbers.map(function(n){ return String(n).trim().toUpperCase(); }).filter(Boolean)
        : [];
      const updatedBy = String(body.updatedBy || 'Unknown').trim();

      const { content, sha } = await getFile();
      content.excludedItemNumbers = itemNumbers;
      content.updatedAt = new Date().toISOString();
      content.updatedBy = updatedBy;

      await putFile(content, sha);
      return res.status(200).json({ ok: true, excludedItemNumbers: itemNumbers });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
module.exports = handler;
