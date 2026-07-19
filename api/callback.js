const https  = require('https');
const qs     = require('querystring');
const { encrypt, parseCookies } = require('./token');

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
        catch(e) { reject(new Error('Bad token response: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchStaffMe(accessToken) {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'api.servicem8.com',
      path:     '/api_1.0/staff/me.json',
      method:   'GET',
      headers: {
        'Accept':        'application/json',
        'Authorization': 'Bearer ' + accessToken
      }
    };
    const req = https.request(options, function(sm8Res) {
      let data = '';
      sm8Res.on('data', function(chunk) { data += chunk; });
      sm8Res.on('end', function() {
        console.log('[callback] staff/me status:', sm8Res.statusCode);
        console.log('[callback] staff/me raw:', data.substring(0, 300));
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch(e) {
          console.log('[callback] staff/me parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', function(e) {
      console.log('[callback] staff/me error:', e.message);
      resolve(null);
    });
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
    console.log('[callback] token keys:', Object.keys(tokenData));

    if (tokenData.error) {
      return res.redirect('/?error=' + encodeURIComponent(tokenData.error_description || tokenData.error));
    }

    // Build and encrypt session payload
    const payload = {
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at:    Date.now() + ((tokenData.expires_in || 3600) * 1000)
    };
    const encrypted = encrypt(payload);

    // Fetch user identity
    let userEmail = tokenData.email || '';
    let userName  = '';

    if (tokenData.access_token) {
      const me = await fetchStaffMe(tokenData.access_token);
      if (me && !me.error) {
        console.log('[callback] staff/me keys:', Object.keys(me));
        const first = me.first      || me.first_name  || me.firstName  || '';
        const last  = me.last       || me.last_name   || me.lastName   || me.surname || '';
        const full  = [first, last].filter(Boolean).join(' ').trim();
        userName  = full || me.name || me.display_name || me.displayName || '';
        userEmail = me.email || me.username || userEmail;
        console.log('[callback] userName:', userName, 'userEmail:', userEmail);
      }
    }

    // Build ALL cookies in one array
    const cookieFlags = '; Path=/; HttpOnly; SameSite=None; Secure';
    const cookiesToSet = [
      'sm8_tok=' + encrypted + cookieFlags + '; Max-Age=86400',
      'sm8_state=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0'
    ];

    if (userEmail) {
      cookiesToSet.push(
        'sm8_user_email=' + encodeURIComponent(userEmail) +
        '; Path=/; SameSite=None; Secure; Max-Age=86400'
      );
    }
    if (userName) {
      cookiesToSet.push(
        'sm8_user_name=' + encodeURIComponent(userName) +
        '; Path=/; SameSite=None; Secure; Max-Age=86400'
      );
    }

    console.log('[callback] setting cookies:', cookiesToSet.map(function(c) {
      return c.split(';')[0];
    }));

    res.setHeader('Set-Cookie', cookiesToSet);
    res.redirect('/');

  } catch(e) {
    console.log('[callback] error:', e.message);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
};
