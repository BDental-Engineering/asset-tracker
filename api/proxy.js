const https  = require('https');
const tokens = require('./token');

function refreshAccessToken(sessionId, refreshToken) {
  const qs   = require('querystring');
  const body = qs.stringify({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     process.env.SM8_CLIENT_ID,
    client_secret: process.env.SM8_CLIENT_SECRET
  });

  return new Promise(function(resolve, reject) {
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
        try {
          const parsed = JSON.parse(data);
          tokens.save(sessionId, parsed);
          resolve(parsed.access_token);
        } catch(e) { reject(e); }
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-HTTP-Method-Override');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Parse session cookie
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(function(c) {
    const parts = c.trim().split('=');
    cookies[parts[0]] = parts.slice(1).join('=');
  });

  const sessionId  = cookies['sm8_session'];
  const tokenData  = sessionId ? tokens.get(sessionId) : null;

  if (!tokenData) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Refresh token if it expires within 60 seconds
  let accessToken = tokenData.access_token;
  if (Date.now() > tokenData.expires_at - 60000) {
    try {
      accessToken = await refreshAccessToken(sessionId, tokenData.refresh_token);
    } catch(e) {
      res.status(401).json({ error: 'Token refresh failed' });
      return;
    }
  }

  const sm8Path = req.query.path || '';
  if (!sm8Path) { res.status(400).json({ error: 'No path provided' }); return; }

  const method = req.headers['x-http-method-override'] || req.method;

  let bodyData = '';
  req.on('data', function(chunk) { bodyData += chunk; });
  req.on('end', function() {
    const options = {
      hostname: 'api.servicem8.com',
      path:     '/api_1.0' + sm8Path,
      method:   method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept':        'application/json'
      }
    };

    if (bodyData) {
      options.headers['Content-Type']   = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const proxy = https.request(options, function(sm8Res) {
      let data = '';
      sm8Res.on('data', function(chunk) { data += chunk; });
      sm8Res.on('end', function() {
        res.setHeader('Content-Type', 'application/json');
        try {
          const parsed = JSON.parse(data);
          res.status(sm8Res.statusCode).json(parsed);
        } catch(e) {
          if ([200,201,204].includes(sm8Res.statusCode)) {
            res.status(sm8Res.statusCode).json({ success: true });
          } else {
            res.status(500).json({ error: 'Invalid JSON', status: sm8Res.statusCode });
          }
        }
      });
    });

    proxy.on('error', function(e) { res.status(500).json({ error: e.message }); });
    if (bodyData) proxy.write(bodyData);
    proxy.end();
  });
};
