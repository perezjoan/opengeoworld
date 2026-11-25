// Generates / copies the engine's built-in assets into apps/world/public/engine-assets/, so the
// world needs nothing from any CDN. Everything is either generated here (original work) or copied
// from packages already in node_modules (licences listed in engine-assets/LICENSES.md).
//
//   node apps/world/scripts/gen-engine-assets.mjs
//
// The avatar and its animations have their own scripts: gen-avatar.mjs, gen-anims.mjs.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../../..');
const OUT = join(here, '../public/engine-assets');
const out = (rel) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); return p; };

// sharp (PNG/JPEG encoder) is a dependency of packages/tools; three of the world app.
const sharp = createRequire(join(root, 'packages/tools/package.json'))('sharp');
// pnpm links each package's dependencies into its own node_modules folder.
const pkgDir = (name, from) => {
  const p = join(root, from, 'node_modules', name);
  if (!existsSync(join(p, 'package.json'))) throw new Error(`${name} not found in ${from}/node_modules: run pnpm install`);
  return p;
};
const threeDir = pkgDir('three', 'apps/world');
const detectGpuDir = pkgDir('detect-gpu', 'packages/engine');

const img = (w, h, ch, data) => sharp(Buffer.from(data.buffer ?? data), { raw: { width: w, height: h, channels: ch } });

// ---------------------------------------------------------------- tileable noise
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Periodic value noise, fbm over octaves; returns 0..1, tiles every `size` pixels. */
function fbm(size, { octaves = 5, base = 8, seed = 1, gain = 0.5 } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o;
    const s = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells, y0 = Math.floor(fy), ty = s(fy - y0);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells, x0 = Math.floor(fx), tx = s(fx - x0);
        const h = (i, j) => hash(((x0 + i) % cells + cells) % cells, ((y0 + j) % cells + cells) % cells, seed + o * 31);
        const a = h(0, 0) + (h(1, 0) - h(0, 0)) * tx;
        const b = h(0, 1) + (h(1, 1) - h(0, 1)) * tx;
        out[y * size + x] += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}
const toGray = (f, size, contrast = 1) => {
  const d = new Uint8Array(size * size * 3);
  for (let i = 0; i < f.length; i++) { const v = Math.max(0, Math.min(255, Math.round(((f[i] - 0.5) * contrast + 0.5) * 255))); d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = v; }
  return d;
};
function normalMap(size, opts, strength = 3) {
  const h = fbm(size, opts);
  const d = new Uint8Array(size * size * 3);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 3;
    d[i] = Math.round((-dx / l * 0.5 + 0.5) * 255); d[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); d[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
  }
  return d;
}

async function textures() {
  await img(256, 256, 3, toGray(fbm(256, { seed: 3 }), 256, 1.6)).jpeg({ quality: 90 }).toFile(out('textures/noise-diffuse.jpg'));
  await img(256, 256, 3, toGray(fbm(256, { seed: 7, base: 4 }), 256, 1.3)).jpeg({ quality: 90 }).toFile(out('textures/noise-lighting.jpg'));
  await img(512, 512, 3, normalMap(512, { seed: 11, base: 6 })).jpeg({ quality: 90 }).toFile(out('textures/normal.jpg'));
  await img(512, 512, 3, normalMap(512, { seed: 13, base: 4, octaves: 6 }, 5)).jpeg({ quality: 90 }).toFile(out('textures/waterNormals.jpg'));
  // stars: dark sky with sparse points
  const st = new Uint8Array(512 * 512 * 3);
  for (let i = 0; i < 1400; i++) {
    const x = Math.floor(hash(i, 1, 5) * 512), y = Math.floor(hash(i, 2, 5) * 512), b = 120 + Math.floor(hash(i, 3, 5) * 135);
    st.set([b, b, Math.min(255, b + 10)], (y * 512 + x) * 3);
  }
  await img(512, 512, 3, st).jpeg({ quality: 92 }).toFile(out('textures/stars.jpg'));
}

async function terrain() {
  // grass: tileable greens with darker clumps and lighter blades
  const N = 512, g1 = fbm(N, { seed: 21, base: 8 }), g2 = fbm(N, { seed: 22, base: 64, octaves: 3 });
  const grass = new Uint8Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    const t = g1[i] * 0.7 + g2[i] * 0.3;
    grass[i * 3] = 52 + t * 60; grass[i * 3 + 1] = 92 + t * 85; grass[i * 3 + 2] = 38 + t * 35;
  }
  await img(N, N, 3, grass).jpeg({ quality: 88 }).toFile(out('terrain/grass.jpg'));
  await img(N, N, 3, grass).resize(64, 64).png().toFile(out('terrain/grassImg-v2.png'));
  // grid: light tile with thin lines on the edges (tiles seamlessly)
  const grid = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const line = Math.min(x, y, N - 1 - x, N - 1 - y) < 3, i = (y * N + x) * 4;
    const v = line ? 150 : 225;
    grid.set([v, v, v, 255], i);
  }
  await img(N, N, 4, grid).png().toFile(out('terrain/grid-v2.png'));
  await img(N, N, 4, grid).resize(64, 64).png().toFile(out('terrain/gridImg-v2.png'));
}

// Default avatar picture (name tags): a neutral head-and-shoulders silhouette on a disc.
async function avatarPic() {
  const N = 128, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4, dx = x - 64, dy = y - 64;
    if (dx * dx + dy * dy > 62 * 62) continue; // transparent outside the disc
    const head = dx * dx + (y - 50) ** 2 < 22 * 22;
    const body = y > 78 && (dx * dx) / (40 * 40) + ((y - 118) ** 2) / (42 * 42) < 1;
    const v = head || body ? [235, 238, 243] : [108, 140, 255];
    d.set([...v, 255], i);
  }
  await img(N, N, 4, d).png().toFile(out('images/avatar-pic.png'));
}

// ---------------------------------------------------------------- studio HDR (Radiance RGBE)
function writeHdr(path, w, h, fn) {
  const head = Buffer.from(`#?RADIANCE\n# opengeoworld generated studio\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, 'ascii');
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x / w, y / h);
    const m = Math.max(r, g, b), i = (y * w + x) * 4;
    if (m < 1e-32) continue;
    const e = Math.ceil(Math.log2(m)), f = 256 / 2 ** e;
    px[i] = Math.min(255, r * f); px[i + 1] = Math.min(255, g * f); px[i + 2] = Math.min(255, b * f); px[i + 3] = e + 128;
  }
  writeFileSync(path, Buffer.concat([head, px])); // flat (non-RLE) scanlines: valid, readers accept them
}
function studio() {
  const lights = [ // [longitude 0..1, latitude 0 (top)..1, radius, intensity, color]
    [0.25, 0.22, 0.07, 9, [1, 0.97, 0.92]],
    [0.72, 0.3, 0.09, 4, [0.9, 0.95, 1]],
    [0.5, 0.05, 0.12, 3, [1, 1, 1]],
  ];
  writeHdr(out('envmap/studio.hdr'), 512, 256, (u, v) => {
    const sky = v < 0.5;
    const t = sky ? v / 0.5 : (v - 0.5) / 0.5;
    let c = sky ? [0.75 + 0.35 * t, 0.8 + 0.3 * t, 0.9 + 0.2 * t].map((x) => x * 1.1) : [0.45 - 0.25 * t, 0.43 - 0.24 * t, 0.4 - 0.22 * t];
    for (const [lu, lv, r, k, col] of lights) {
      const du = Math.min(Math.abs(u - lu), 1 - Math.abs(u - lu)) * 2, dv = v - lv;
      const g = Math.exp(-(du * du + dv * dv) / (2 * r * r));
      c = c.map((x, i) => x + g * k * col[i]);
    }
    return c;
  });
}

// ---------------------------------------------------------------- SDF font (BMFont JSON, "msdf")
// Single-channel signed distance stored in R=G=B, so the engine's MSDF shader (median of the three
// channels) reads it as a regular SDF. Glyph outlines: Droid Sans Bold (Apache 2.0, from three.js).
async function font() {
  const face = JSON.parse(readFileSync(join(threeDir, 'examples/fonts/droid/droid_sans_bold.typeface.json'), 'utf8'));
  const SIZE = 64, PAD = 3, RANGE = 4, W = 512;
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890 _-'[]/().,:?€$£¥*@#+!°&\"%=«»“”—…™;©¨^{}~`|\\<>".split('');

  const contoursOf = (g) => {
    const o = (g.o || '').trim().split(/\s+/);
    const cs = []; let cur = null, i = 0, last = [0, 0];
    const n = () => parseFloat(o[i++]);
    while (i < o.length) {
      const cmd = o[i++];
      if (cmd === 'm') { cur = [[n(), n()]]; cs.push(cur); last = cur[0]; }
      else if (cmd === 'l') { last = [n(), n()]; cur.push(last); }
      else if (cmd === 'q') { const e = [n(), n()], c = [n(), n()], s = last; for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; cur.push([u * u * s[0] + 2 * u * t * c[0] + t * t * e[0], u * u * s[1] + 2 * u * t * c[1] + t * t * e[1]]); } last = e; }
      else if (cmd === 'b') { const e = [n(), n()], c1 = [n(), n()], c2 = [n(), n()], s = last; for (let k = 1; k <= 10; k++) { const t = k / 10, u = 1 - t; cur.push([u ** 3 * s[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * e[0], u ** 3 * s[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * e[1]]); } last = e; }
    }
    return cs;
  };
  // em size: Droid's cap height is ~71% of the em
  const H = contoursOf(face.glyphs.H).flat();
  const capUnits = Math.max(...H.map((p) => p[1]));
  const scale = (0.714 * SIZE) / capUnits;
  const base = Math.round(face.ascender * scale);
  const lineHeight = Math.round((face.ascender - face.descender) * scale);

  const glyphs = [];
  for (const ch of charset) {
    const g = face.glyphs[ch];
    if (!g) continue;
    const cs = contoursOf(g);
    const pts = cs.flat();
    if (!pts.length) { glyphs.push({ ch, w: 0, h: 0, xadvance: Math.round(g.ha * scale), xoffset: 0, yoffset: 0, data: null }); continue; }
    const xmin = Math.min(...pts.map((p) => p[0])), xmax = Math.max(...pts.map((p) => p[0]));
    const ymin = Math.min(...pts.map((p) => p[1])), ymax = Math.max(...pts.map((p) => p[1]));
    const w = Math.ceil((xmax - xmin) * scale) + 2 * PAD, h = Math.ceil((ymax - ymin) * scale) + 2 * PAD;
    const segs = [];
    for (const c of cs) for (let i = 0; i < c.length; i++) segs.push([c[i], c[(i + 1) % c.length]]);
    const data = new Uint8Array(w * h);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const fx = xmin + (px + 0.5 - PAD) / scale, fy = ymax - (py + 0.5 - PAD) / scale;
      let dmin = Infinity, wind = 0;
      for (const [a, b] of segs) {
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((fx - a[0]) * ex + (fy - a[1]) * ey) / (ex * ex + ey * ey || 1)));
        dmin = Math.min(dmin, Math.hypot(fx - (a[0] + t * ex), fy - (a[1] + t * ey)));
        if ((a[1] <= fy) !== (b[1] <= fy)) { const xi = a[0] + ((fy - a[1]) / (b[1] - a[1])) * ex; if (xi > fx) wind += b[1] > a[1] ? 1 : -1; }
      }
      const sd = (wind !== 0 ? 1 : -1) * dmin * scale; // pixels, positive inside
      data[py * w + px] = Math.max(0, Math.min(255, Math.round((0.5 + sd / RANGE) * 255)));
    }
    glyphs.push({ ch, w, h, data, xadvance: Math.round(g.ha * scale), xoffset: Math.round(xmin * scale) - PAD, yoffset: Math.round(base - ymax * scale) - PAD });
  }
  // shelf packing
  const order = glyphs.filter((g) => g.data).sort((a, b) => b.h - a.h);
  let x = 1, y = 1, rowH = 0;
  for (const g of order) {
    if (x + g.w + 1 > W) { x = 1; y += rowH + 1; rowH = 0; }
    g.x = x; g.y = y; x += g.w + 1; rowH = Math.max(rowH, g.h);
  }
  const Hh = y + rowH + 1 <= 512 ? 512 : 1024;
  const atlas = new Uint8Array(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) atlas[i * 4 + 3] = 255;
  for (const g of order) for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
    const v = g.data[r * g.w + c], i = ((g.y + r) * W + g.x + c) * 4;
    atlas[i] = atlas[i + 1] = atlas[i + 2] = v;
  }
  await img(W, Hh, 4, atlas).png().toFile(out('fonts/droid-sans-bold/tex.png'));
  const json = {
    pages: ['tex.png'],
    chars: glyphs.map((g, index) => ({
      id: g.ch.codePointAt(0), index, char: g.ch, width: g.w, height: g.h, xoffset: g.xoffset, yoffset: g.yoffset,
      xadvance: g.xadvance, chnl: 15, x: g.x ?? 0, y: g.y ?? 0, page: 0,
    })),
    info: { face: 'DroidSans-Bold', size: SIZE, bold: 1, italic: 0, charset: glyphs.map((g) => g.ch), unicode: 1, stretchH: 100, smooth: 1, aa: 1, padding: [PAD, PAD, PAD, PAD], spacing: [0, 0] },
    common: { lineHeight, base, scaleW: W, scaleH: Hh, pages: 1, packed: 0, alphaChnl: 0, redChnl: 0, greenChnl: 0, blueChnl: 0 },
    distanceField: { fieldType: 'msdf', distanceRange: RANGE },
    kernings: [],
  };
  writeFileSync(out('fonts/droid-sans-bold/json.json'), JSON.stringify(json));
  return glyphs.length;
}

// ---------------------------------------------------------------- copies from node_modules
function copies() {
  for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) cpSync(join(threeDir, 'examples/jsm/libs/draco', f), out(`js/draco/${f}`));
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) cpSync(join(threeDir, 'examples/jsm/libs/basis', f), out(`js/basis/${f}`));
  const bench = join(detectGpuDir, 'dist/benchmarks');
  for (const f of readdirSync(bench)) cpSync(join(bench, f), out(`detect-gpu/${f}`));
}

function licenses() {
  writeFileSync(out('LICENSES.md'), `# engine-assets

Built-in assets of the engine, served with the site (no CDN). Regenerate with the scripts in
\`apps/world/scripts/\` (gen-engine-assets.mjs, gen-avatar.mjs, gen-anims.mjs).

| Path | Origin | Licence |
|---|---|---|
| vrms/ | generated by gen-avatar.mjs (original) | MIT (this repo) |
| jsons/defaultAnims.json, ../assets/anims/ | generated by gen-anims.mjs (original keyframes) | MIT (this repo) |
| textures/, terrain/, envmap/, images/ | generated by gen-engine-assets.mjs (procedural) | MIT (this repo) |
| fonts/droid-sans-bold/ | distance field generated from Droid Sans Bold outlines (three.js examples/fonts/droid) | Apache License 2.0, © 2005-2008 The Android Open Source Project |
| js/draco/ | Draco decoder, copied from three.js examples/jsm/libs/draco | Apache License 2.0, © Google |
| js/basis/ | Basis Universal transcoder, copied from three.js examples/jsm/libs/basis | Apache License 2.0, © Binomial LLC |
| detect-gpu/ | GPU benchmark data, copied from the detect-gpu package | MIT, © Tim van Scherpenzeel |
`);
}

copies();
await textures();
await terrain();
await avatarPic();
studio();
const nGlyphs = await font();
licenses();
console.log(`engine-assets ready (${nGlyphs} glyphs in the font)`);
