#!/usr/bin/env node

import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [artifactRoot, portPath, markerPath] = process.argv.slice(2);
if (!artifactRoot || !portPath || !markerPath) throw new Error('usage: control-order-server.mjs <artifact-root> <port-file> <marker-file>');

const expected = [
  'authorization.json',
  'authorization-audit.jsonl',
  'engagement.json',
  'engagement-state.json',
  'heartbeat/odysseus.log',
];
const server = createServer((request, response) => {
  const present = Object.fromEntries(expected.map((name) => [name, existsSync(join(artifactRoot, 'ai_agents_internal', name))]));
  writeFileSync(markerPath, `${JSON.stringify({ method: request.method, present }, null, 2)}\n`);
  response.writeHead(204);
  response.end();
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(portPath, `${server.address().port}\n`);
});

setTimeout(() => server.close(), 15_000).unref();
