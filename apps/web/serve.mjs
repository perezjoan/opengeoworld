// opengeoworld DEVELOPMENT server (zero dependencies): node apps/web/serve.mjs [port]
//
// Production needs no server at all: `pnpm build` writes plain files to dist/ for any static
// host (OVH, Apache, nginx…). This server only reproduces that layout while you develop:
//
//   /                  the 3-step app (apps/web, served from disk, no build step)
//   /world/...         proxied to the world app's Next.js dev server (live reload included)
//   /api/world-status  is that dev server up? (the page hides its status pill when this is absent)
//
// The world dev server is started here if it isn't running, and stopped when this server quits.
// Environment variables:
//   WEB_PORT         port of this server                   (default 8765, or the first argument)
//   WORLD_URL        the world dev server                  (default http://localhost:3000)
//   WORLD_ROOT       repo root                             (default: two folders up from here)
//   WORLD_PROJECT    world app inside it                   (default apps/world)
//   WORLD_AUTOSTART  set to 0 to start the world dev server yourself (pnpm world)
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR } from './vendor.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2] || process.env.WEB_PORT || 8765);
const repoRoot = resolve(process.env.WORLD_ROOT || join(here, '../..'));
const worldProject = process.env.WORLD_PROJECT || 'apps/world';
const world = new URL(process.env.WORLD_URL || 'http://localhost:3000');
const worldPort = Number(world.port || 80);

// ---------- world dev server ----------

let worldChild = null;

async function worldReachable() {
  try {
    const res = await fetch(new URL('/world/', world), { signal: AbortSignal.timeout(4000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function worldState() {
  if (await worldReachable()) return 'running';
  if (worldChild && worldChild.exitCode === null) return 'starting';
  if (!existsSync(join(repoRoot, worldProject, 'package.json'))) return 'missing';
  if (!existsSync(join(repoRoot, 'node_modules'))) return 'not-installed';
  return 'stopped';
}

async function startWorld() {
  const pkg = JSON.parse(await readFile(join(repoRoot, worldProject, 'package.json'), 'utf8'));
  if (!/^[@\w./-]+$/.test(pkg.name)) throw new Error(`Unexpected package name: ${pkg.name}`);
  console.log(`[world] starting "${pkg.name}" dev server…`);
  // Next.js reads PORT. One command string (shell needed on Windows for npx.cmd); name validated above.
  const env = { ...process.env, PORT: String(worldPort) };
  worldChild = spawn(`npx -y pnpm@10.10.0 --filter ${pkg.name} dev`, { cwd: repoRoot, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log('[world]', l));
  worldChild.stdout.on('data', relay);
  worldChild.stderr.on('data', relay);
  worldChild.on('exit', (code) => console.log(`[world] dev server exited (${code})`));
}

function stopWorld() {
  if (!worldChild || worldChild.exitCode !== null) return;
  // shell:true on Windows -> kill the whole tree (cmd -> npx -> pnpm -> next)
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(worldChild.pid), '/T', '/F'], () => {});
  else worldChild.kill('SIGTERM');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopWorld(); setTimeout(() => process.exit(0), 300); });
process.on('exit', stopWorld);

// ---------- /world proxy (same origin as the page, like on the real site) ----------

function proxyWorld(req, res) {
  const upstream = http.request(
    { host: world.hostname, port: worldPort, method: req.method, path: req.url, headers: { ...req.headers, host: world.host } },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '2' });
    res.end('<!doctype html><meta http-equiv="refresh" content="2"><body style="font:16px system-ui;background:#0f1115;color:#aab;display:grid;place-items:center;height:100vh;margin:0">The world app is starting… this page retries by itself.</body>');
  });
  req.pipe(upstream);
}

// Live reload uses a websocket: pass the upgrade through untouched.
function proxyWorldUpgrade(req, socket, head) {
  const upstream = net.connect(worldPort, world.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: world.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

// ---------- static (only the web app's own files) ----------

const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const STATIC = /^(index\.html|src[\\/][\w.-]+\.(js|css)|assets[\\/](facades|fonts|brand|geoid)[\\/][\w.-]+\.(jpg|png|svg|json|woff2?|txt|i16))$/;

const server = http.createServer(async (req, res) => {
  if (req.url === '/world' ) { res.writeHead(301, { Location: '/world/' }).end(); return; }
  if (req.url.startsWith('/world/')) return proxyWorld(req, res);
  if (req.method === 'GET' && req.url.startsWith('/api/world-status')) return json(res, 200, { state: await worldState() });

  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([/\\])+/, '');
  const vendorFile = VENDOR[rel.replace(/\\/g, '/')];
  if (!STATIC.test(rel) && !vendorFile) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(vendorFile || join(here, rel));
    res.writeHead(200, { 'Content-Type': types[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
const onUpgrade = (req, socket, head) => {
  if (req.url.startsWith('/world/')) proxyWorldUpgrade(req, socket, head);
  else socket.destroy();
};
server.on('upgrade', onUpgrade);
// "localhost" can mean IPv6 (::1) to the browser, notably for websockets (live reload): listen on
// both loopback addresses (still local only, nothing exposed to the network).
const server6 = http.createServer((req, res) => server.emit('request', req, res));
server6.on('upgrade', onUpgrade);
server6.on('error', () => {}); // no IPv6 on this machine: fine
server6.listen(port, '::1');
server.listen(port, '127.0.0.1', async () => {
  console.log(`opengeoworld (dev) on http://localhost:${port}`);
  const state = await worldState();
  console.log(`[world] ${world.origin}: ${state}`);
  if (state === 'stopped' && process.env.WORLD_AUTOSTART !== '0') startWorld().catch((e) => console.error('[world] start failed:', e.message));
  if (state === 'not-installed') console.log(`[world] run "npx -y pnpm@10.10.0 install" in ${repoRoot} first`);
  if (state === 'missing') console.log(`[world] no app at ${join(repoRoot, worldProject)}: set WORLD_ROOT / WORLD_PROJECT`);
});
