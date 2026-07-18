// Simple in-memory store — works fine on Vercel serverless
// Tokens are keyed by a session ID stored in a cookie
const store = {};

module.exports = {
  save: function(sessionId, tokenData) {
    store[sessionId] = {
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at:    Date.now() + (tokenData.expires_in * 1000),
      account_uuid:  tokenData.account_uuid || ''
    };
  },
  get: function(sessionId) {
    return store[sessionId] || null;
  },
  remove: function(sessionId) {
    delete store[sessionId];
  }
};
