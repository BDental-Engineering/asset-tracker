const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/history.json';
const MAX_RECORDS  = 500;

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
  if (res.status === 404) return { content: [], sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    if (req.body && typeof req.body === 'object') {
      return resolve(req.body);
    }
    let raw = '';
    req.on('data', function(chunk) { raw += chunk; });
    req.on('end', function() {
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch(e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REPO || !GITHUB_TOKEN) {
    console.log('[history] missing env vars');
    return res.status(500).json({ error: 'GitHub not configured' });
  }

  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      console.log('[history] GET returning', content.length, 'records');
      return res.status(200).json(content);
    } catch (e) {
      console.log('[history] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const newRecord = await parseBody(req);

      if (!newRecord || typeof newRecord !== 'object') {
        console.log('[history] POST bad body:', newRecord);
        return res.status(400).json({ error: 'Invalid record' });
      }

      console.log('[history] POST new record:', JSON.stringify(newRecord).substring(0, 120));

      const { content: existing, sha } = await getFile();
      console.log('[history] existing records:', existing.length, '| sha:', sha);

      const updated = [newRecord].concat(existing).slice(0, MAX_RECORDS);
      const encoded = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');

      const pushPayload = {
        message: 'Update asset history',
        content: encoded,
        branch:  BRANCH
      };
      if (sha) pushPayload.sha = sha;

      const pushRes = await githubRequest('PUT', '/repos/' + REPO + '/contents/' + PATH, pushPayload);

      if (pushRes.status !== 200 && pushRes.status !== 201) {
        throw new Error('GitHub write failed: ' + pushRes.status + ' ' + JSON.stringify(pushRes.body));
      }

      console.log('[history] POST saved', updated.length, 'records to GitHub');
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.log('[history] POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
