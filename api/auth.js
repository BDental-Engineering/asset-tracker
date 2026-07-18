const crypto = require('crypto');
const { parseCookies } = require('./token');

module.exports = function(req, res) {
  const state = crypto.randomBytes(16).toString('hex');

  res.setHeader('Set-Cookie',
    'sm8_state=' + state + '; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=600'
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.SM8_CLIENT_ID,
    redirect_uri:  process.env.SM8_REDIRECT_URI,
    scope:         'manage_assets read_customers',
    state:         state
  });

  res.redirect('https://go.servicem8.com/oauth/authorize?' + params.toString());
};
