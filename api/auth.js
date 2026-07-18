const crypto = require('crypto');

module.exports = function(req, res) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const state     = crypto.randomBytes(16).toString('hex');

  // Store state in a short-lived cookie for CSRF protection
  res.setHeader('Set-Cookie', [
    'sm8_session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
    'sm8_state='   + state     + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'
  ]);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.SM8_CLIENT_ID,
    redirect_uri:  process.env.SM8_REDIRECT_URI,
    scope:         'manage_assets read_customers',
    state:         state
  });

  res.redirect('https://go.servicem8.com/oauth/authorize?' + params.toString());
};
