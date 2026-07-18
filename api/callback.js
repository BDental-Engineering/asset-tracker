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

function fetchStaffMe(accessToken) {
  return new Promise(function(resolve, reject) {
    const options = {
      hostname: 'api.servicem8.com',
      path:     '/api/staff/me.json',
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
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
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

    // Try to get the logged-in user's email and name
    let userEmail = '';
    let userName  = '';

    // ServiceM8 sometimes includes the email directly in the token response
    if (tokenData.email) {
      userEmail = tokenData.email;
    }

    // Fetch /staff/me.json for the definitive logged-in user record
    if (tokenData.access_token) {
      const me = await fetchStaffMe(tokenData.access_token);
      if (me && !me.error) {
        // Use 'first' + 'last' (ServiceM8 field names)
        const first = me.first || me.first_name || '';
        const last  = me.last  || me.last_name  || '';
        userName  = [first, last].filter(Boolean).join(' ').trim() || me.name || '';
        userEmail = me.email || userEmail;
      }
    }

    // Set the session token cookie
    setSessionCookie(res, tokenData);

    // Build cookie array — session + clear state + user identity cookies
    const existingCookie = res.getHeader('Set-Cookie');
    const sessionCookie  = Array.isArray(existingCookie) ? existingCookie[0] : existingCookie;

    const cookiesToSet = [
      sessionCookie,
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

    res.setHeader('Set-Cookie', cookiesToSet);
    res.redirect('/');

  } catch(e) {
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
};
