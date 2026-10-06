// Composition root: HTTP API + live event stream + dashboard, the ACS control
// plane, and the Meili agent gateway — all on one port.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Acs } from './core/acs.js';
import { MeiliGateway } from './adapters/meili/gateway.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

export function createServer({ site = readJson('config/site.json'), fleet = readJson('config/fleet.json'), options, auditFile } = {}) {
  const server = http.createServer((req, res) => handle(req, res).catch((err) => json(res, 400, { error: err.message })));
  const gateway = new MeiliGateway(server, fleet);
  const acs = new Acs(site, fleet.vehicles, gateway, options);
  const trace = [];
  const streams = new Set();

  gateway.on('trace', (frame) => {
    trace.push(frame);
    if (trace.length > 200) trace.shift();
  });
  if (auditFile) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const audit = fs.createWriteStream(auditFile, { flags: 'a' });
    acs.on('event', (entry) => audit.write(`${JSON.stringify(entry)}\n`));
  }
  acs.on('tick', () => {
    if (!streams.size) return;
    const data = `data: ${JSON.stringify({ ...acs.snapshot(), trace: trace.slice(-60) })}\n\n`;
    for (const res of streams) res.write(data);
  });

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function body(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${pathname}`;
    const [, , resource, id, action] = pathname.split('/');

    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, 'public/index.html')).pipe(res);
    }
    if (route === 'GET /api/site') return json(res, 200, site);
    if (route === 'GET /api/state') return json(res, 200, { ...acs.snapshot(), trace: trace.slice(-60) });
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (route === 'POST /api/orders') return json(res, 201, acs.createOrder(await body(req)));
    if (req.method === 'POST' && resource === 'orders' && action === 'cancel') return json(res, 200, acs.cancelOrder(id));
    if (req.method === 'POST' && resource === 'robots' && (action === 'pause' || action === 'resume')) {
      acs.pauseRobot(id, action === 'pause');
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  }

  return { server, acs, gateway };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8900);
  const { server, acs } = createServer({ auditFile: path.join(ROOT, 'data/events.jsonl') });
  acs.on('event', (e) => console.log(`${new Date(e.ts).toISOString().slice(11, 23)} ${e.level.padEnd(5)} ${e.type.padEnd(20)} ${e.message}`));
  acs.start();
  server.listen(port, () => {
    console.log(`ACS dashboard      http://localhost:${port}/`);
    console.log(`Meili agent gateway ws://localhost:${port}/ws/fleets/`);
  });
}
