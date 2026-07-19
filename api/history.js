const { Octokit } = require('@octokit/rest');

const OWNER_REPO  = (process.env.GITHUB_REPO || '').split('/');
const OWNER       = OWNER_REPO[0];
const REPO        = OWNER_REPO[1];
const BRANCH      = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH   = 'data/history.json';
const MAX_RECORDS = 500;

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    // If Vercel already parsed it
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

async function getFile(octokit) {
  try {
    const res = await octokit.repos.getContent({
      owner: OWNER,
      repo:  REPO,
      path:  FILE_PATH,
      ref:   BRANCH
    });
    const content = Buffer.from(res.data.content, 'base64').toString('utf8');
    const data    = JSON.parse(content);
    const sha     = res.data.sha;
    return { data, sha: sha };
  } catch (e) {
    if (e.status === 404) return { [], sha: null };
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!OWNER || !REPO) {
    console.log('[history] GITHUB_REPO env var not set correctly');
    return res.status(500).json({ error: 'GitHub repo not configured' });
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  if (req.method === 'GET') {
    try {
      const result = await getFile(octokit);
      console.log('[history] GET returning', result.data.length, 'records');
      return res.status(200).json(result.data);
    } catch (e) {
      console.log('[history] GET error:', e.message);
      return res.status(500).json({ error: 'GitHub read failed: ' + e.message });
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

      const result   = await getFile(octokit);
      const existing = result.data;
      const sha      = result.sha;

      console.log('[history] existing records:', existing.length, '| sha:', sha);

      const updated = [newRecord].concat(existing).slice(0, MAX_RECORDS);
      const encoded = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');

      const pushPayload = {
        owner:   OWNER,
        repo:    REPO,
        path:    FILE_PATH,
        branch:  BRANCH,
        message: 'Update asset history',
        content: encoded
      };
      if (sha) pushPayload.sha = sha;

      await octokit.repos.createOrUpdateFileContents(pushPayload);

      console.log('[history] POST saved', updated.length, 'records to GitHub');
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.log('[history] POST error:', e.message);
      console.log('[history] POST stack:', e.stack);
      return res.status(500).json({ error: 'GitHub write failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
