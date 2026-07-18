const { clearSessionCookie } = require('./token');

module.exports = function(req, res) {
  clearSessionCookie(res);
  res.redirect('/');
};
