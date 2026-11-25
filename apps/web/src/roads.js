// Roads and sidewalks that follow the terrain.
// Each road centreline is resampled every few metres (map data only has a point where a road
// turns, so a straight stretch can run 200 m between points and would cut through a hill); the
// ribbon's height is measured at its own left and right edges, not at the centre, so a wide road
// across a slope tilts with it. Heights come from the terrain *mesh* (same triangles as the ground
// the player walks on), slightly above it. Bridges interpolate between their ends; tunnels are
// skipped. Sidewalks are separate ribbons beside urban streets, a bit lower than the carriageway
// so the carriageway wins where streets cross.
import * as THREE from 'three';

const STEP = 2.5;           // resampling step along a road (m): below the ~3 m terrain cells
const ACROSS = 3.5;         // max strip width across a ribbon (m): wide roads get inner rows too
const ROAD_UP = 0.16;       // carriageway above the terrain (m)
const WALK_UP = 0.11;       // sidewalk above the terrain (m)
const RAIL_UP = 0.22;       // railway ballast above the terrain (m)
const SIDEWALK_W = 2.2;     // sidewalk width (m)
const DASH = 6;             // metres per texture repeat along a road (3 m dash, 3 m gap)

// ---------------------------------------------------------------- textures / materials
function canvasTex(name, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.name = name;
  t.userData.mimeType = 'image/jpeg';
  return t;
}
const grain = (ctx, base, spread, n = 2500) => {
  ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < n; i++) {
    const g = (Math.random() - 0.5) * spread;
    ctx.fillStyle = `rgba(${g > 0 ? 255 : 0},${g > 0 ? 255 : 0},${g > 0 ? 255 : 0},${Math.abs(g) / 255})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
};

export function createRoadKit() {
  const mat = (name, map, roughness = 0.95) => { const m = new THREE.MeshStandardMaterial({ map, roughness }); m.name = name; return m; };
  // bridge structure: the deck's sides, parapets and underside in stone (seen from the river)
  const bridge = mat('bridge', canvasTex('bridge-stone', (ctx) => {
    grain(ctx, '#b4ab99', 34, 1800);
    ctx.strokeStyle = 'rgba(70,64,55,0.35)'; ctx.lineWidth = 2;
    for (let y = 0; y <= 256; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke(); }
    for (let y = 0; y < 256; y += 32) for (let x = (y / 32) % 2 ? 32 : 0; x <= 256; x += 64) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 32); ctx.stroke(); }
  }), 0.9);
  bridge.side = THREE.DoubleSide;
  return {
    bridge,
    road: mat('road', canvasTex('asphalt', (ctx) => grain(ctx, '#45484e', 60))),
    roadLine: mat('road-line', canvasTex('asphalt-line', (ctx) => {
      grain(ctx, '#45484e', 60);
      ctx.fillStyle = 'rgba(235,235,225,0.9)';
      ctx.fillRect(0, 123, 128, 10); // dashed centre line (v = 0.5 across the ribbon)
    })),
    sidewalk: mat('sidewalk', canvasTex('pavers', (ctx) => {
      grain(ctx, '#a19d94', 40, 1500);
      ctx.strokeStyle = 'rgba(80,80,80,0.35)'; ctx.lineWidth = 2;
      for (let i = 0; i <= 256; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke(); }
      ctx.fillStyle = '#c4c0b7'; ctx.fillRect(0, 238, 256, 18); // curb stones on the street side (v ≈ 1)
    }), 0.9),
    path: mat('path', canvasTex('gravel', (ctx) => grain(ctx, '#bba57d', 90, 4000))),
    paved: mat('paved', canvasTex('paving', (ctx) => {
      grain(ctx, '#a6a298', 36, 1500);
      ctx.strokeStyle = 'rgba(90,90,90,0.28)'; ctx.lineWidth = 2;
      for (let i = 0; i <= 256; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke(); }
      for (let i = 0; i <= 256; i += 64) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke(); }
    }), 0.9),
    // railway: ballast, sleepers across (4 per 2.4 m repeat), two rails at standard gauge on a 3.4 m bed
    rail: mat('rail', canvasTex('track', (ctx) => {
      grain(ctx, '#77706a', 80, 5000);
      ctx.fillStyle = '#5a4a3c';
      for (let x = 10; x < 256; x += 64) ctx.fillRect(x, 40, 30, 176);
      for (const y of [74, 182]) {
        ctx.fillStyle = '#3a3c40'; ctx.fillRect(0, y - 5, 256, 10);
        ctx.fillStyle = '#b9bec4'; ctx.fillRect(0, y - 2, 256, 3);
      }
    }), 0.8),
    // tram rails set in the street: only the two grooves, the rest transparent (alpha mask)
    tram: Object.assign(mat('tram-rails', Object.assign(canvasTex('tram', (ctx) => {
      ctx.clearRect(0, 0, 256, 256);
      for (const y of [26, 230]) { ctx.fillStyle = '#2c2e31'; ctx.fillRect(0, y - 6, 256, 12); ctx.fillStyle = '#a8adb3'; ctx.fillRect(0, y - 2, 256, 3); }
    }), { userData: { mimeType: 'image/png' } }), 0.6), { transparent: false, alphaTest: 0.5 }), // PNG: keeps the transparency in the GLB
  };
}

// ---------------------------------------------------------------- geometry
function resample(line) {
  const out = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / STEP));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Left normals at each point (averaged at joints, miter clamped). */
function normals(pts) {
  const ns = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    let nx = -ty, ny = tx, scale = 1;
    if (i > 0 && i < pts.length - 1) { // miter: 1/cos(half angle), clamped
      const p = pts[i - 1], q = pts[i];
      const sx = q[0] - p[0], sy = q[1] - p[1], sl = Math.hypot(sx, sy) || 1;
      const cos = Math.max(0.5, Math.abs((-sy / sl) * nx + (sx / sl) * ny));
      scale = 1 / cos;
    }
    ns.push([nx * scale, ny * scale]);
  }
  return ns;
}

const v3 = (e, h, n) => [e, h, -n];

/**
 * One ribbon between offsets o0..o1 (metres to the left of the centreline; negative = right).
 * zAt(point, i) gives the height at a ribbon edge point.
 */
/**
 * A bridge's structure under and beside its deck: a 1.2 m thick slab (underside facing down) and a
 * 0.9 m parapet wall on each edge, outside the sidewalks. Without it a deck is a sheet of road that
 * vanishes when seen from below or from the side.
 */
const SLAB = 1.2, PARAPET = 0.9;
function bridgeSlab(out, r, pts, ns, cum, lift, inside) {
  const W = r.width / 2 + (r.sides?.left || r.sides?.right ? SIDEWALK_W : 0) + 0.25;
  const top = lift(ROAD_UP);
  const deck = pts.map((p, i) => top(p, i));
  // underside: o0 < o1 gives the downward-facing winding
  ribbon(out, pts, ns, cum, -W, W, (p, i) => deck[i] - SLAB, 4, inside);
  for (const side of [W, -W]) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (!inside(pts[i]) && !inside(pts[i + 1])) continue;
      const a = [pts[i][0] + ns[i][0] * side, pts[i][1] + ns[i][1] * side], b = [pts[i + 1][0] + ns[i + 1][0] * side, pts[i + 1][1] + ns[i + 1][1] * side];
      const A0 = v3(a[0], deck[i] - SLAB, a[1]), A1 = v3(a[0], deck[i] + PARAPET, a[1]);
      const B0 = v3(b[0], deck[i + 1] - SLAB, b[1]), B1 = v3(b[0], deck[i + 1] + PARAPET, b[1]);
      const ua = cum[i] / 4, ub = cum[i + 1] / 4, vt = (SLAB + PARAPET) / 4;
      out.pos.push(...A0, ...B0, ...B1, ...A0, ...B1, ...A1);
      out.uv.push(ua, 0, ub, 0, ub, vt, ua, 0, ub, vt, ua, vt);
    }
  }
}

function ribbon(out, pts, ns, cum, o0, o1, zAt, uPeriod, inside) {
  const strips = Math.max(1, Math.ceil(Math.abs(o0 - o1) / ACROSS)); // rows across, so the surface follows the ground
  for (let i = 0; i < pts.length - 1; i++) {
    if (!inside(pts[i]) && !inside(pts[i + 1])) continue;
    const P = (k, o) => [pts[k][0] + ns[k][0] * o, pts[k][1] + ns[k][1] * o];
    const ua = cum[i] / uPeriod, ub = cum[i + 1] / uPeriod;
    for (let s = 0; s < strips; s++) {
      const v0 = s / strips, v1 = (s + 1) / strips;
      const q0 = o0 + (o1 - o0) * v0, q1 = o0 + (o1 - o0) * v1;
      const a0 = P(i, q0), a1 = P(i, q1), b0 = P(i + 1, q0), b1 = P(i + 1, q1);
      const A0 = v3(a0[0], zAt(a0, i), a0[1]), A1 = v3(a1[0], zAt(a1, i), a1[1]);
      const B0 = v3(b0[0], zAt(b0, i + 1), b0[1]), B1 = v3(b1[0], zAt(b1, i + 1), b1[1]);
      // o0 > o1 (left edge first): A0,A1,B1 / A0,B1,B0 face up; otherwise reverse the winding
      if (o0 > o1) {
        out.pos.push(...A0, ...A1, ...B1, ...A0, ...B1, ...B0);
        out.uv.push(ua, v0, ua, v1, ub, v1, ua, v0, ub, v1, ub, v0);
      } else {
        out.pos.push(...A0, ...B1, ...A1, ...A0, ...B0, ...B1);
        out.uv.push(ua, v0, ub, v1, ua, v1, ua, v0, ub, v0, ub, v1);
      }
    }
  }
}

/**
 * roads: [{ line: [[e,n]…], width, kind: 'road'|'path', lanes, sidewalk: 0|1|2 (none/left+right…),
 *           sides: { left, right }, bridge, tunnel }] in local metres.
 * terrainAt(e, n): height of the terrain mesh. size: half-size of the terrain square.
 * Returns { parts: Map(material → { pos, uv }), count }.
 */
export function buildRoads(roads, { terrainAt, size, kit, waterFloor = () => -Infinity }) {
  const parts = new Map();
  const part = (m) => { if (!parts.has(m)) parts.set(m, { pos: [], uv: [] }); return parts.get(m); };
  const inside = ([e, n]) => Math.abs(e) <= size && Math.abs(n) <= size;
  let count = 0;
  for (const r of roads) {
    if (r.tunnel || r.line.length < 2) continue;
    const pts = resample(r.line);
    if (!pts.some(inside)) continue;
    const clamp = ([e, n]) => [Math.max(-size, Math.min(size, e)), Math.max(-size, Math.min(size, n))];
    const ground = (p) => Math.max(terrainAt(...clamp(p)), waterFloor(p[0], p[1]));
    const ns = normals(pts);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1];
    // bridges: straight between the ground at both ends (never below the terrain)
    // deck heights at the ends: from mesh.js (the whole bridge, all its pieces), else the ground
    const [z0, z1] = r.deck || [ground(pts[0]), ground(pts[pts.length - 1])];
    // streets meeting a bridge (r.ramp from mesh.js): from the deck height at that end, down 12 %
    // at most, and landing on the ground at the street's other end; never below the ground
    const RAMP = 0.12;
    const ramp = (deck, s, far) => { const even = deck + (far - deck) * (s / (total || 1)); return far >= deck ? even : Math.min(deck - RAMP * s, even); };
    const lift = (up) => (p, i) => {
      let g = ground(p) + up;
      if (r.bridge) return Math.max(g, z0 + (z1 - z0) * (cum[i] / (total || 1)) + up + 0.4);
      if (r.ramp?.[0] != null) g = Math.max(g, ramp(r.ramp[0] + up + 0.4, cum[i], z1 + up));
      if (r.ramp?.[1] != null) g = Math.max(g, ramp(r.ramp[1] + up + 0.4, total - cum[i], z0 + up));
      return g;
    };
    const w = r.width / 2;
    if (r.kind === 'rail') {
      ribbon(part(kit.rail), pts, ns, cum, w, -w, lift(RAIL_UP), 2.4, inside);
    } else if (r.kind === 'tram') {
      ribbon(part(kit.tram), pts, ns, cum, w, -w, lift(ROAD_UP + 0.03), 2.4, inside); // on the carriageway
    } else if (r.kind === 'pedestrian' || r.kind === 'footway') {
      ribbon(part(kit.paved), pts, ns, cum, w, -w, lift(WALK_UP + 0.03), 3, inside); // paved: squares, footways, cycleways
    } else if (r.kind === 'path') {
      ribbon(part(kit.path), pts, ns, cum, w, -w, lift(WALK_UP + 0.02), 4, inside);
    } else {
      ribbon(part(r.lanes >= 2 && r.width >= 6 ? kit.roadLine : kit.road), pts, ns, cum, w, -w, lift(ROAD_UP), DASH, inside);
      // sidewalks: v = 0 outside, v = 1 at the curb (curb stones drawn there in the texture)
      if (r.sides?.left) ribbon(part(kit.sidewalk), pts, ns, cum, w + SIDEWALK_W, w, lift(WALK_UP), 2, inside);
      if (r.sides?.right) ribbon(part(kit.sidewalk), pts, ns, cum, -w - SIDEWALK_W, -w, lift(WALK_UP), 2, inside);
    }
    if (r.bridge && kit.bridge) bridgeSlab(part(kit.bridge), r, pts, ns, cum, lift, inside);
    count++;
  }
  return { parts, count };
}
