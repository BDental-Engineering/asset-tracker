const crypto = require('crypto');

module.exports = function(req, res) {
  const email = (req.query.email || '').trim().toLowerCase();

  if (!email) {
    return res.redirect('/?error=no_email');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const statePayload = Buffer.from(nonce + ':' + email).toString('base64url');

  res.setHeader('Set-Cookie',
    'sm8_state=' + statePayload + '; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=600'
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.SM8_CLIENT_ID,
    redirect_uri:  process.env.SM8_REDIRECT_URI,
    scope:         'manage_assets read_customers manage_staff read_staff read_job_contacts read_jobs manage_jobs read_job_activity manage_job_activity read_job_checklist manage_job_checklist',
    state:         statePayload
  });

  res.redirect('https://go.servicem8.com/oauth/authorize?' + params.toString());
};
