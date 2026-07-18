const https  = require('https');
const qs     = require('querystring');
const { getSession, setSessionCookie } = require('./token');

function refreshToken(refreshTok) {
  return new Promise(function(resolve, reject) {
    const body = qs.stringify({
      grant_type:    'refresh_token',
      refresh_token: refreshTok,
      client_id:     process.env.SM8_CLIENT_ID,
      client_secret: process.env.SM8_CLIENT_SECRET
    });
    const options = {
      hostname: 'go.servicem8.com',
      path:     '/oauth/access_token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, function(sm8Res) {
      let data = '';
      sm8Res.on('data', function(chunk) { data += chunk; });
      sm8Res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HTTP-Method-Override');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let session = getSession(req);

  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Refresh if expiring within 60 seconds
  if (Date.now() > session.expires_at - 60000) {
    try {
      const newTokens = await refreshToken(session.refresh_token);
      setSessionCookie(res, newTokens);
      session = {
        access_token:  newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at:    Date.now() + ((newTokens.expires_in || 3600) * 1000)
      };
    } catch(e) {
      res.status(401).json({ error: 'Token refresh failed' });
      return;
    }
  }

  let sm8Path = req.query.path || '';
  if (!sm8Path) { res.status(400).json({ error: 'No path provided' }); return; }

  // Ensure path starts with a single /
  if (!sm8Path.startsWith('/')) sm8Path = '/' + sm8Path;

  const method = req.headers['x-http-method-override'] || req.method;

  let bodyData = '';
  req.on('data', function(chunk) { bodyData += chunk; });
  req.on('end', function() {

    const options = {
      hostname: 'api.servicem8.com',
      path:     '/api' + sm8Path,   // ← was '/api_1.0' which returns 403
      method:   method,
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Accept':        'application/json'
      }
    };

    console.log('[proxy] -->', method, options.path);

    if (bodyData) {
      options.headers['Content-Type']   = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const proxy = https.request(options, function(sm8Res) {
      let data = '';
      sm8Res.on('data', function(chunk) { data += chunk; });
      sm8Res.on('end', function() {
        console.log('[proxy] <--', sm8Res.statusCode, options.path);
        res.setHeader('Content-Type', 'application/json');
        try {
          res.status(sm8Res.statusCode).json(JSON.parse(data));
        } catch(e) {
          if ([200, 201, 204].includes(sm8Res.statusCode)) {
            res.status(sm8Res.statusCode).json({ success: true });
          } else {
            res.status(500).json({ error: 'Invalid JSON', status: sm8Res.statusCode, raw: data.substring(0, 200) });
          }
        }
      });
    });

    proxy.on('error', function(e) {
      console.log('[proxy] error:', e.message);
      res.status(500).json({ error: e.message });
    });

    if (bodyData) proxy.write(bodyData);
    proxy.end();
  });
};
