#!/usr/bin/env node
// Minimal target for the end-to-end runner smokes. It binds 127.0.0.1 only; PORT=0 (the
// default) picks an ephemeral port. The first stdout line is `listening <port>`.
//   FAULTY_MODE=buggy  GET /widgets/1 answers 500 {"error":"boom"} (the observed defect)
//   FAULTY_MODE=fixed  GET /widgets/1 answers 200 {"id":1,"name":"widget"} (the specification)
// GET /health and POST /auth/login answer 200 in both modes; anything else is 404.
import { createServer } from 'node:http';

const mode = process.env.FAULTY_MODE ?? 'buggy';
if (mode !== 'buggy' && mode !== 'fixed') {
  process.stderr.write(`faulty-target: FAULTY_MODE must be buggy or fixed, got ${mode}\n`);
  process.exit(2);
}
const port = Number(process.env.PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('faulty-target: PORT must be an integer in 0..65535\n');
  process.exit(2);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer((req, res) => {
  // Drain any request body so keep-alive connections stay usable.
  req.resume();
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/health') send(res, 200, { status: 'ok' });
    else if (req.method === 'POST' && path === '/auth/login') send(res, 200, { token: 't' });
    else if (req.method === 'GET' && path === '/widgets/1') {
      if (mode === 'buggy') send(res, 500, { error: 'boom' });
      else send(res, 200, { id: 1, name: 'widget' });
    } else send(res, 404, { error: 'not-found' });
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
