const { Octokit } = require('@octokit/rest');

const OWNER_REPO = (process.env.GITHUB_REPO || '').split('/');
const OWNER = OWNER_REPO[0];
const REPO = OWNER_REPO[1];
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const FILE_PATH = 'data/history.json';
const MAX_RECORDS = 500;

async function getFile(octokit) {
  try {
    const res = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: FILE_PATH, ref: BRANCH });
    const content = Buffer.from(res.data.content, 'base64').toString('utf8');
    return { JSON.parse(content), sha: res.data.sha };
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

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  if (req.method === 'GET') {
    try {
      const { data } = await getFile(octokit);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: 'GitHub read failed: ' + e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const newRecord = req.body;
      if (!newRecord || typeof newRecord !== 'object') {
        return res.status(400).json({ error: 'Invalid record' });
      }
      const { existing, sha } = await getFile(octokit);
      const updated = [newRecord, ...existing].slice(0, MAX_RECORDS);
      const encoded = Buffer.from(JSON.stringify(updated, null, 2)).toString('base64');
      await octokit.repos.createOrUpdateFileContents({
        owner: OWNER, repo: REPO, path: FILE_PATH, branch: BRANCH,
        message: 'Update asset history',
        content: encoded,
        ...(sha ? { sha } : {})
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'GitHub write failed: ' + e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
