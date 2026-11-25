// Build the whole site as static files in dist/, ready to upload to any static host (OVH…).
//
//   OGW_BASE_PATH=/opengeoworld  node scripts/build.mjs     (site at https://example.com/opengeoworld/)
//   node scripts/build.mjs                                  (site at the domain root)
//
// dist/
//   index.html, src/…      the 3-step app (apps/web, copied as is)
//   assets/facades/        the photo facade library (tiles + library.json)
//   world/…                the world app (Next.js static export, served under <base>/world/)
//   .htaccess              MIME types, compression and caching for Apache (OVH web hosting)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const arg = process.argv.find((a) => a.startsWith('--base='))?.slice(7);
const base = (arg ?? process.env.OGW_BASE_PATH ?? '').replace(/\/+$/, '');
if (!/^(\/[\w.-]+)*$/.test(base)) {
  console.error(`The base path must look like "/folder" or "/a/b" (got "${base}").`);
  if (/^[A-Za-z]:/.test(base)) console.error('Git Bash rewrote it into a Windows path: run from PowerShell, or prefix the command with MSYS_NO_PATHCONV=1.');
  process.exit(1);
}

// one version everywhere: package.json (the release) and apps/web/src/version.js (shown in the app)
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const appVersion = readFileSync(join(root, 'apps/web/src/version.js'), 'utf8').match(/VERSION = '([^']+)'/)?.[1];
if (version !== appVersion) {
  console.error(`package.json says ${version} but apps/web/src/version.js says ${appVersion}: make them match.`);
  process.exit(1);
}

console.log(`\n▸ Building the world app for ${base || '(domain root)'}/world/ …\n`);
const worldOut = join(root, 'apps/world/out');
rmSync(worldOut, { recursive: true, force: true }); // stale export (other base path, old files)
const r = spawnSync('npx -y pnpm@10.10.0 --filter @opengeoworld/world build', {
  cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, OGW_BASE_PATH: base },
});
if (r.status !== 0 || !existsSync(join(worldOut, 'index.html'))) {
  console.error('\nWorld build failed (no apps/world/out/index.html).');
  process.exit(1);
}

console.log('\n▸ Assembling dist/ …');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'src'), { recursive: true });
cpSync(join(root, 'apps/web/index.html'), join(dist, 'index.html'));
for (const f of readdirSync(join(root, 'apps/web/src'))) {
  if (/\.(js|css)$/.test(f)) cpSync(join(root, 'apps/web/src', f), join(dist, 'src', f));
}
cpSync(join(root, 'apps/web/assets'), join(dist, 'assets'), { recursive: true }); // photo facade library
cpSync(worldOut, join(dist, 'world'), { recursive: true });
const { VENDOR } = await import(pathToFileURL(join(root, 'apps/web/vendor.mjs')).href);
for (const [rel, src] of Object.entries(VENDOR)) {
  mkdirSync(dirname(join(dist, rel)), { recursive: true });
  cpSync(src, join(dist, rel));
}

writeFileSync(join(dist, '.htaccess'), `# opengeoworld: static site (Apache / OVH web hosting). No server code runs here.
DirectoryIndex index.html
Options -Indexes

AddType application/wasm .wasm
AddType model/gltf-binary .glb
AddType application/json .json
AddType font/woff2 .woff2
AddType font/woff .woff
AddType image/svg+xml .svg

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript application/json application/wasm image/svg+xml
</IfModule>

<IfModule mod_headers.c>
  # Next.js build files have content hashes in their names: cache them for a year.
  <If "%{REQUEST_URI} =~ m#/_next/static/#">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </If>
  # Everything else (the 3-step app, scene, html): always revalidate so updates show up.
  <Else>
    Header set Cache-Control "no-cache"
  </Else>
</IfModule>
`);
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ name: 'OpenGeoWorld', version, basePath: base, builtAt: new Date().toISOString() }, null, 2) + '\n');

let files = 0, bytes = 0;
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
  }
})(dist);

console.log(`\n✓ dist/ ready: ${files} files, ${(bytes / 1e6).toFixed(1)} MB, for ${base || '(domain root)'}/`);
console.log(`  Try it locally:  node scripts/preview.mjs   → http://localhost:8080${base}/`);
console.log(`  Deploy: upload the CONTENTS of dist/ (including .htaccess) to the matching folder on your host.\n`);
