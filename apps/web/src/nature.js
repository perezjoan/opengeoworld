// Trees and water. Everything here works in the local metric frame (east, north) used by mesh.js;
// 3D positions are [east, height, -north] (glTF Y-up, -Z north).
import * as THREE from 'three';

// ---------------------------------------------------------------- polygon helpers
export function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const inPolygon = (x, y, poly) => pointInRing(x, y, poly.outer) && !poly.holes.some((h) => pointInRing(x, y, h));

export function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

export function bbox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

/** Sutherland–Hodgman clip of a ring to the square [-s, s]². */
export function clipToSquare(ring, s) {
  let out = ring;
  const edges = [[0, -s, 1], [0, s, -1], [1, -s, 1], [1, s, -1]]; // [axis, value, keep side]
  for (const [ax, v, side] of edges) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const ina = (a[ax] - v) * side >= 0, inb = (b[ax] - v) * side >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const t = (v - a[ax]) / (b[ax] - a[ax]); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
  }
  return out;
}

/** Point index over polygons for fast "is this point inside any of them" tests. */
export function polygonIndex(polys) {
  const items = polys.map((p) => ({ p, b: bbox(p.outer) }));
  return (x, y) => items.some(({ p, b }) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inPolygon(x, y, p));
}

// ---------------------------------------------------------------- water
/**
 * Water polygons → level (m, model frame) from the terrain under them: a low percentile of ground
 * samples inside the polygon (rivers sit below their quays).
 */
export function waterLevels(waters, ground) {
  for (const w of waters) {
    const [x0, y0, x1, y1] = bbox(w.outer);
    const step = Math.max(4, Math.sqrt(((x1 - x0) * (y1 - y0)) / 400));
    const hs = [];
    for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) if (inPolygon(x, y, w)) hs.push(ground(x, y));
    if (!hs.length) for (const [x, y] of w.outer) hs.push(ground(x, y));
    hs.sort((a, b) => a - b);
    w.level = hs[Math.floor(hs.length * 0.15)] - 0.3;
  }
  return waters;
}

/** Flat water mesh (for the downloadable GLB; the world draws its own animated water). */
export function waterMesh(waters) {
  const pos = [];
  for (const w of waters) {
    const contour = w.outer.map(([x, y]) => new THREE.Vector2(x, y));
    const holes = w.holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
    const all = [...contour, ...holes.flat()];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      let a = all[i], b = all[j], c = all[k];
      if ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) < 0) [b, c] = [c, b];
      pos.push(a.x, w.level, -a.y, b.x, w.level, -b.y, c.x, w.level, -c.y);
    }
  }
  return pos;
}

// ---------------------------------------------------------------- trees
// Seeded random so a place looks the same every time it's built.
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)) >>> 0) / 4294967296;
}

const ICO = new THREE.IcosahedronGeometry(1, 0);
const icoPos = ICO.getAttribute('position');

/**
 * Append one low-poly tree. kind: 'broad' (rounded crown), 'conifer' (two cones), 'small' (street
 * tree). Pushes triangles into trunk[] and crowns[colourIndex][] (flat arrays of xyz).
 */
/** Push triangle a,b,c facing away from `inside` (all [x,y,z]). */
function tri(out, a, b, c, inside) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const m = [(a[0] + b[0] + c[0]) / 3 - inside[0], (a[1] + b[1] + c[1]) / 3 - inside[1], (a[2] + b[2] + c[2]) / 3 - inside[2]];
  if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) out.push(...a, ...c, ...b);
  else out.push(...a, ...b, ...c);
}

function addTree(trunk, crowns, x, y, base, h, kind, rand) {
  const N = 5;
  const trunkH = kind === 'conifer' ? h * 0.25 : h * 0.42;
  const tr = Math.max(0.12, h * 0.022);
  const P = (dx, yy, dz) => [x + dx, yy, -(y + dz)];
  const axis = (yy) => [x, yy, -y];
  for (let i = 0; i < N; i++) { // trunk: 5-sided prism
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const b0 = P(Math.cos(a0) * tr, base, Math.sin(a0) * tr), b1 = P(Math.cos(a1) * tr, base, Math.sin(a1) * tr);
    const t0 = P(Math.cos(a0) * tr * 0.7, base + trunkH + 0.4, Math.sin(a0) * tr * 0.7), t1 = P(Math.cos(a1) * tr * 0.7, base + trunkH + 0.4, Math.sin(a1) * tr * 0.7);
    const mid = axis(base + trunkH / 2);
    tri(trunk, b0, b1, t1, mid);
    tri(trunk, b0, t1, t0, mid);
  }
  const col = crowns[Math.floor(rand() * crowns.length)];
  if (kind === 'conifer') {
    const layers = [[trunkH, h * 0.2, h * 0.62], [trunkH + h * 0.3, h * 0.14, h * 0.45]];
    for (const [y0, r, hh] of layers) {
      const tip = P(0, base + y0 + hh, 0), c = P(0, base + y0, 0), inside = axis(base + y0 + hh * 0.3);
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI * 2 + 0.3, a1 = ((i + 1) / 6) * Math.PI * 2 + 0.3;
        const p0 = P(Math.cos(a0) * r, base + y0, Math.sin(a0) * r), p1 = P(Math.cos(a1) * r, base + y0, Math.sin(a1) * r);
        tri(col, p0, p1, tip, inside);
        tri(col, p0, p1, c, inside);
      }
    }
    return;
  }
  // rounded crown: a jittered icosahedron (or two for big trees)
  const blobs = kind === 'broad' && h > 9 ? 2 : 1;
  for (let k = 0; k < blobs; k++) {
    const r = (kind === 'small' ? h * 0.3 : h * 0.34) * (blobs > 1 ? 0.8 : 1);
    const ox = blobs > 1 ? (k ? 0.45 : -0.45) * r : 0, oz = blobs > 1 ? (rand() - 0.5) * 0.6 * r : 0;
    const cy = base + trunkH + r * (0.75 + 0.1 * k);
    const jit = [];
    for (let i = 0; i < icoPos.count; i++) jit.push(0.82 + rand() * 0.36);
    // icosahedron positions are non-indexed (60 vertices); keep shared corners identical
    const key = (i) => `${icoPos.getX(i).toFixed(3)},${icoPos.getY(i).toFixed(3)},${icoPos.getZ(i).toFixed(3)}`;
    const jitBy = {};
    for (let i = 0; i < icoPos.count; i++) jitBy[key(i)] ??= jit[i];
    const V = (i) => { const s = jitBy[key(i)]; return P(ox + icoPos.getX(i) * r * s, cy + icoPos.getY(i) * r * 0.85 * s, oz + icoPos.getZ(i) * r * s); };
    const centre = P(ox, cy, oz);
    for (let i = 0; i < icoPos.count; i += 3) tri(col, V(i), V(i + 1), V(i + 2), centre);
  }
}

/**
 * Plant trees: individual trees (points), tree rows (lines) and vegetation areas (polygons with a
 * density), skipping buildings, water and anything outside the radius. Returns flat position arrays.
 */
export function plantTrees({ points = [], rows = [], areas = [], ground, radius, blocked, max = 1600, seed = 1 }) {
  const rand = rng(seed);
  const spots = []; // [x, y, h, kind, generated]
  for (const p of points) spots.push([p[0], p[1], p[2] || 8 + rand() * 6, rand() < 0.15 ? 'broad' : 'small', false]);
  for (const line of rows) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i], [bx, by] = line[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      for (let d = 0; d < len; d += 8) spots.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len, 8 + rand() * 4, 'small', false]);
    }
  }
  for (const a of areas) {
    const area = Math.abs(ringArea(a.outer)) - a.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    let n = Math.round(area / a.spacing ** 2);
    const [x0, y0, x1, y1] = bbox(a.outer);
    for (let tries = 0; n > 0 && tries < n * 4; tries++) {
      const x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0);
      if (!inPolygon(x, y, a)) continue;
      spots.push([x + (rand() - 0.5) * 2, y + (rand() - 0.5) * 2, a.height[0] + rand() * (a.height[1] - a.height[0]), a.kinds[Math.floor(rand() * a.kinds.length)], true]);
      n--;
    }
  }
  const ok = spots.filter(([x, y]) => Math.hypot(x, y) <= radius && !blocked(x, y));
  // too many: keep a uniform sample (individual trees first, they matter most in streets)
  const kept = ok.length > max ? ok.filter((_, i) => i < points.length || rand() < (max - Math.min(max, points.length)) / Math.max(1, ok.length - points.length)) : ok;
  // mapped trees (real positions: single trees, tree rows) and generated ones (planted in woods and
  // parks at random spots) are kept apart, so the generated ones can be hidden
  const mapped = { trunk: [], crowns: [[], [], []], count: 0 }, generated = { trunk: [], crowns: [[], [], []], count: 0 };
  for (const [x, y, h, kind, gen] of kept.slice(0, max)) {
    const g = gen ? generated : mapped;
    addTree(g.trunk, g.crowns, x, y, ground(x, y) - 0.2, h, kind, rand);
    g.count++;
  }
  return { mapped, generated, count: mapped.count + generated.count, spots: kept.slice(0, max).map(([x, y, h, kind, gen]) => ({ x, y, h, kind, generated: gen })) };
}
