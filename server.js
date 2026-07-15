const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const SM8_BASE = 'api.servicem8.com';

const server = http.createServer((req, res) => {

  // ── Serve index.html ──
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── Proxy /api/* → ServiceM8 ──
  if (req.url.startsWith('/api/')) {
    const sm8Path = req.url.replace('/api/', '/api_1.0/');
    const authHeader = req.headers['authorization'] || '';

    const options = {
      hostname: SM8_BASE,
      path: sm8Path,
      method: req.method,
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    const proxy = https.request(options, (sm8Res) => {
      res.writeHead(sm8Res.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      sm8Res.pipe(res);
    });

    proxy.on('error', (e) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    });

    req.pipe(proxy);
    return;
  }

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✅ Asset Tracker running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.`);
});
