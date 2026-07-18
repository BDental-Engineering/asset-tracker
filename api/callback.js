const https   = require('https');
const qs      = require('querystring');
const tokens  = require('./token');

function exchangeCode(code) {
  return new Promise(function(resolve, reject) {
    const body = qs.stringify({
      grant_type:    'authorization_code',
      code:          code,
      redirect_uri:  process.env.SM8_REDIRECT_URI,
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
        catch(e) { reject(new Error('Bad response from ServiceM8: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  // Parse cookies
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(function(c) {
    const parts = c.trim().split('=');
    cookies[parts[0]] = parts.slice(1).join('=');
  });

  const sessionId    = cookies['sm8_session'];
  const storedState  = cookies['sm8_state'];

  if (!sessionId || !storedState || storedState !== state) {
    return res.status(400).send('Invalid state — possible CSRF attempt.');
  }

  try {
    const tokenData = await exchangeCode(code);

    if (tokenData.error) {
      return res.redirect('/?error=' + encodeURIComponent(tokenData.error_description || tokenData.error));
    }

    tokens.save(sessionId, tokenData);

    // Set a long-lived session cookie and clear the state cookie
    res.setHeader('Set-Cookie', [
      'sm8_session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400',
      'sm8_state=; Path=/; HttpOnly; Max-Age=0'
    ]);

    res.redirect('/');
  } catch(e) {
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
};
