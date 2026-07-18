const https  = require('https');
const qs     = require('querystring');
const { setSessionCookie, parseCookies } = require('./token');

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
        catch(e) { reject(new Error('Bad response: ' + data)); }
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

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  const cookies     = parseCookies(req);
  const storedState = cookies['sm8_state'];

  if (!storedState || storedState !== state) {
    return res.status(400).send('Invalid state parameter.');
  }

  try {
    const tokenData = await exchangeCode(code);

    if (tokenData.error) {
      return res.redirect('/?error=' + encodeURIComponent(tokenData.error_description || tokenData.error));
    }

    // Set encrypted token cookie and clear state cookie
    const cookies_to_set = [
      'sm8_tok=' + require('./token').getSession, // placeholder — use setSessionCookie below
      'sm8_state=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0'
    ];

    // Use setSessionCookie then append the state clear
    setSessionCookie(res, tokenData);
    const existing = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [
      Array.isArray(existing) ? existing[0] : existing,
      'sm8_state=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0'
    ]);

    res.redirect('/');
  } catch(e) {
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
};
