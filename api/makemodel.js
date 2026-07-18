const https = require('https');

const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN  = process.env.GITHUB_TOKEN;
const PATH   = 'data/makemodel.json';

function githubRequest(method, urlPath, body) {
  return new Promise(function(resolve, reject) {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path:     urlPath,
      method:   method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'User-Agent':    'asset-tracker',
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (payload) {
      options.headers['Content-Type']   = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
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
  if (res.status === 404) return { content: [], sha: null };
  if (res.status !== 200) throw new Error('GitHub read failed: ' + res.status);
  const content = JSON.parse(Buffer.from(res.body.content, 'base64').toString('utf8'));
  return { content, sha: res.body.sha };
}

async function putFile(data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = {
    message: 'Update make/model data',
    content: content,
    branch:  BRANCH
  };
  if (sha) body.sha = sha;
  const res = await githubRequest('PUT', '/repos/' + REPO + '/contents/' + PATH, body);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res.body;
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Auth check — must have valid session cookie
  const { getSession } = require('./token');
  if (!getSession(req)) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      res.status(200).json(content);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('Expected an array');
        const { sha } = await getFile();
        await putFile(data, sha);
        res.status(200).json({ ok: true });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
