const http = require('http');

const port = Number(process.env.PORT || 3210);
http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ ok: true, path: request.url }));
}).listen(port, '0.0.0.0');
