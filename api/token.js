const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'fallback-secret-change-me';
const ALG    = 'aes-256-gcm';

function encrypt(obj) {
  const iv  = crypto.randomBytes(12);
  const key = crypto.scryptSync(SECRET, 'salt', 32);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const text = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decrypt(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const encrypted = buf.slice(28);
    const key = crypto.scryptSync(SECRET, 'salt', 32);
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const text = decipher.update(encrypted) + decipher.final('utf8');
    return JSON.parse(text);
  } catch(e) {
    return null;
  }
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(function(c) {
    const parts = c.trim().split('=');
    cookies[parts[0].trim()] = parts.slice(1).join('=');
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies['sm8_tok'];
  if (!raw) return null;
  return decrypt(raw);
}

function setSessionCookie(res, tokenData) {
  const payload = {
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    Date.now() + ((tokenData.expires_in || 3600) * 1000)
  };
  const encrypted = encrypt(payload);
  res.setHeader('Set-Cookie',
    'sm8_tok=' + encrypted + '; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400'
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    'sm8_tok=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0'
  );
}

module.exports = { getSession, setSessionCookie, clearSessionCookie, parseCookies };
