// Serve dist/ the way a plain static host does: files only, no application logic, no API.
// If the 3 steps work here, they work on OVH.
//
//   node scripts/preview.mjs [port]      → http://localhost:8080<base>/  (base from the last build)
import http from 'node:http';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(join(dist, 'index.html'))) {
  console.error('No dist/ yet: run "npx -y pnpm@10.10.0 build" first.');
  process.exit(1);
}
const { basePath = '' } = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'));
const port = Number(process.argv[2] || 8080);

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain', '.map': 'application/json',
};

http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/' && basePath) { res.writeHead(302, { Location: `${basePath}/` }).end(); return; }
  if (!path.startsWith(`${basePath}/`) && path !== basePath) { res.writeHead(404).end('not found'); return; }

  let rel = normalize(path.slice(basePath.length)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  let file = join(dist, rel);
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith('/')) { res.writeHead(301, { Location: `${path}/` }).end(); return; } // like Apache
    file = join(file, 'index.html');
  }
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`dist/ served as plain static files on http://localhost:${port}${basePath}/`);
});
