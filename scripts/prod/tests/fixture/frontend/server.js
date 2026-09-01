const http = require('http');

http.createServer((_request, response) => {
  response.end('fixture frontend');
}).listen(5174, '0.0.0.0');
