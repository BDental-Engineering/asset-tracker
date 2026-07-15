const https = require('https');

module.exports = async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const sm8Path = req.query.path || '';

  if (!sm8Path) {
    res.status(400).json({ error: 'No path provided' });
    return;
  }

  const options = {
    hostname: 'api.servicem8.com',
    path: '/api_1.0' + sm8Path,
    method: req.method,
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };

  return new Promise((resolve) => {
    const proxy = https.request(options, (sm8Res) => {
      let data = '';
      sm8Res.on('data', chunk => data += chunk);
      sm8Res.on('end', () => {
        try {
          res.status(sm8Res.statusCode).json(JSON.parse(data || '[]'));
        } catch(e) {
          res.status(500).json({ error: 'Invalid JSON from ServiceM8' });
        }
        resolve();
      });
    });

    proxy.on('error', (e) => {
      res.status(500).json({ error: e.message });
      resolve();
    });

    proxy.end();
  });
};
