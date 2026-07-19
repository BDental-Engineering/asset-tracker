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

function fetchStaffList(accessToken) {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'api.servicem8.com',
      path:     '/api_1.0/staff.json',
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
        try   { resolve(JSON.parse(data)); }
        catch (e) {
          console.log('[callback] staff.json parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', function(e) {
      console.log('[callback] staff.json error:', e.message);
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

  // Decode email from state
  let emailFromState = '';
  try {
    const decoded  = Buffer.from(storedState, 'base64url').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    emailFromState = colonIdx !== -1 ? decoded.slice(colonIdx + 1).toLowerCase() : '';
  } catch(e) {
    console.log('[callback] state decode error:', e.message);
  }
  console.log('[callback] email from state:', emailFromState);

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

    // Match staff by email from state
    let userEmail = emailFromState;
    let userName  = '';
    let userUuid  = '';

    const staffList = await fetchStaffList(tokenData.access_token);

    if (Array.isArray(staffList) && staffList.length > 0) {
      // Try exact email match first, then fall back to first active staff
      const me = staffList.find(function(s) {
        return (s.email || '').toLowerCase() === emailFromState;
      }) || staffList.find(function(s) {
        return String(s.active) === '1';
      }) || staffList[0];

      const first = me.first || me.first_name || '';
      const last  = me.last  || me.last_name  || me.surname || '';
      userName  = [first, last].filter(Boolean).join(' ').trim() || me.name || '';
      userEmail = me.email || emailFromState;
      userUuid  = me.uuid  || '';

      console.log('[callback] resolved user:', userName, userEmail, userUuid);
    }

    // Build cookies
    const cookieFlags = '; Path=/; HttpOnly; SameSite=None; Secure';
    const cookiesToSet = [
      'sm8_tok='   + encrypted  + cookieFlags + '; Max-Age=86400',
      'sm8_state=' + cookieFlags + '; Max-Age=0'
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
    if (userUuid) {
      cookiesToSet.push(
        'sm8_user_uuid=' + encodeURIComponent(userUuid) +
        '; Path=/; SameSite=None; Secure; Max-Age=86400'
      );
    }

    res.setHeader('Set-Cookie', cookiesToSet);
    res.redirect('/');

  } catch(e) {
    console.log('[callback] error:', e.message);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
};
