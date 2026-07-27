// api/suppliers.js
// Stores supplier definitions in data/suppliers.json on GitHub
// Structure: { "supplier_uuid": { name, contact, prefix, entries: [ { materialName, productCode } ] } }
//
// GET    /api/suppliers              → entire suppliers map
// POST   /api/suppliers              → create/update supplier  body: { id?, name, contact?, prefix? }
// DELETE /api/suppliers              → body: { id }
//
// GET    /api/suppliers?lookup=name  → find supplier + productCode for a material name
// POST   /api/suppliers/entry        → body: { supplierId, materialName, productCode }
// DELETE /api/suppliers/entry        → body: { supplierId, materialName }

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO         = process.env.GITHUB_REPO;
const BRANCH       = process.env.GITHUB_BRANCH || 'main';
const PATH         = 'data/suppliers.json';

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
  const payload = { message: 'Update suppliers', content: encoded, branch: BRANCH };
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

  const isEntry = req.url && req.url.includes('/entry');

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { content } = await getFile();
      const lookup = req.query && req.query.lookup;
      if (lookup) {
        const name = lookup.toLowerCase().trim();
        for (const id of Object.keys(content)) {
          const sup = content[id];
          const entry = (sup.entries || []).find(function(e) {
            return e.materialName.toLowerCase().trim() === name;
          });
          if (entry) return res.status(200).json({ supplierId: id, supplierName: sup.name, productCode: entry.productCode });
        }
        return res.status(200).json(null);
      }
      return res.status(200).json(content);
    } catch(e) {
      console.log('[suppliers] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const { content, sha } = await getFile();

      if (isEntry) {
        const supplierId   = String(body.supplierId   || '').trim();
        const materialName = String(body.materialName || '').trim();
        const productCode  = String(body.productCode  || '').trim();

        if (!supplierId || !materialName) return res.status(400).json({ error: 'supplierId and materialName required' });
        if (!content[supplierId]) return res.status(404).json({ error: 'Supplier not found' });

        if (!Array.isArray(content[supplierId].entries)) content[supplierId].entries = [];

        const existing = content[supplierId].entries.findIndex(function(e) {
          return e.materialName.toLowerCase() === materialName.toLowerCase();
        });

        const entry = { materialName, productCode };
        if (existing >= 0) content[supplierId].entries[existing] = entry;
        else content[supplierId].entries.push(entry);

        content[supplierId].entries.sort(function(a, b) {
          return a.materialName.localeCompare(b.materialName);
        });

        await putFile(content, sha);
        return res.status(200).json({ ok: true });

      } else {
        const id      = String(body.id      || '').trim() || Date.now() + '-' + Math.random().toString(36).slice(2,7);
        const name    = String(body.name    || '').trim();
        const contact = String(body.contact || '').trim();
        const prefix  = String(body.prefix  || '').trim().toUpperCase().substring(0, 10);

        if (!name) return res.status(400).json({ error: 'name is required' });

        if (!content[id]) content[id] = { entries: [] };
        content[id].name    = name;
        content[id].contact = contact;
        content[id].prefix  = prefix;

        await putFile(content, sha);
        return res.status(200).json({ ok: true, id });
      }

    } catch(e) {
      console.log('[suppliers] POST error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      const { content, sha } = await getFile();

      if (isEntry) {
        const supplierId   = String(body.supplierId   || '').trim();
        const materialName = String(body.materialName || '').trim();
        if (!supplierId || !materialName) return res.status(400).json({ error: 'supplierId and materialName required' });
        if (!content[supplierId]) return res.status(404).json({ error: 'Supplier not found' });

        content[supplierId].entries = (content[supplierId].entries || []).filter(function(e) {
          return e.materialName.toLowerCase() !== materialName.toLowerCase();
        });

        await putFile(content, sha);
        return res.status(200).json({ ok: true });

      } else {
        const id = String(body.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id is required' });
        delete content[id];
        await putFile(content, sha);
        return res.status(200).json({ ok: true });
      }

    } catch(e) {
      console.log('[suppliers] DELETE error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

handler.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
module.exports = handler;
