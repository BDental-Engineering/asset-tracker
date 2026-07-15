const https = require('https');

module.exports = function(req, res) {
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

  const proxy = https.request(options, function(sm8Res) {
    let data = '';
    sm8Res.on('data', function(chunk) { data += chunk; });
    sm8Res.on('end', function() {
      res.setHeader('Content-Type', 'application/json');
      try {
        const parsed = JSON.parse(data);
        res.status(sm8Res.statusCode).json(parsed);
      } catch(e) {
        res.status(500).json({
          error: 'Invalid JSON from ServiceM8',
          status: sm8Res.statusCode,
          raw: data.substring(0, 500)
        });
      }
    });
  });

  proxy.on('error', function(e) {
    res.status(500).json({ error: e.message });
  });

  proxy.end();
};
