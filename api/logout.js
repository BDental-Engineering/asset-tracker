const tokens = require('./token');

module.exports = function(req, res) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(function(c) {
    const parts = c.trim().split('=');
    cookies[parts[0]] = parts.slice(1).join('=');
  });

  const sessionId = cookies['sm8_session'];
  if (sessionId) tokens.remove(sessionId);

  res.setHeader('Set-Cookie', 'sm8_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
};
