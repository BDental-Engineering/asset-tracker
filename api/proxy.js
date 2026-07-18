const https = require('https');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-HTTP-Method-Override');

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

  // Use X-HTTP-Method-Override if present, otherwise use the actual method
  const method = req.headers['x-http-method-override'] || req.method;

  // Collect the request body for POST/PUT
  let bodyData = '';
  req.on('data', function(chunk) { bodyData += chunk; });
  req.on('end', function() {

    const options = {
      hostname: 'api.servicem8.com',
      path: '/api_1.0' + sm8Path,
      method: method,
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    };

    // Only set Content-Type and Content-Length if there is a body
    if (bodyData) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    console.log('Proxying:', method, options.hostname + options.path);
    console.log('Auth header present:', !!authHeader);
    if (bodyData) console.log('Body being sent:', bodyData.substring(0, 300));

    const proxy = https.request(options, function(sm8Res) {
      let data = '';
      sm8Res.on('data', function(chunk) { data += chunk; });
      sm8Res.on('end', function() {
        console.log('SM8 status:', sm8Res.statusCode);
        console.log('SM8 raw response:', data.substring(0, 300));
        res.setHeader('Content-Type', 'application/json');
        try {
          const parsed = JSON.parse(data);
          res.status(sm8Res.statusCode).json(parsed);
        } catch(e) {
          // ServiceM8 sometimes returns empty body on success
          if (sm8Res.statusCode === 200 || sm8Res.statusCode === 201 || sm8Res.statusCode === 204) {
            res.status(sm8Res.statusCode).json({ success: true });
          } else {
            res.status(500).json({
              error: 'Invalid JSON from ServiceM8',
              status: sm8Res.statusCode,
              raw: data.substring(0, 500)
            });
          }
        }
      });
    });

    proxy.on('error', function(e) {
      console.log('Proxy error:', e.message);
      res.status(500).json({ error: e.message });
    });

    // Write the body and close the request
    if (bodyData) proxy.write(bodyData);
    proxy.end();
  });
};
