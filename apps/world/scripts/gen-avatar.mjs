// Generates the default avatar of opengeoworld: a faceted low-poly human, rigged as a VRM 1.0,
// written by hand as a GLB (no Blender, no downloads). Everything here is original work.
//
//   node apps/world/scripts/gen-avatar.mjs
//
// Output: apps/world/public/engine-assets/vrms/human.vrm (+ human-lod.vrm, same file for now)
//
// Frame (VRM 1.0): metres, Y up, the model faces +Z, the character's left is +X, T-pose,
// every bone with identity rotation (only translations).
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = fileURLToPath(new URL('../public/engine-assets/vrms/', import.meta.url));

// ---------------------------------------------------------------- skeleton (world positions, T-pose)
const B = {}; // name -> { parent, pos:[x,y,z] }
const bone = (name, parent, pos) => (B[name] = { name, parent, pos });
bone('hips', null, [0, 0.95, 0]);
bone('spine', 'hips', [0, 1.05, 0]);
bone('chest', 'spine', [0, 1.19, 0]);
bone('upperChest', 'chest', [0, 1.32, 0]);
bone('neck', 'upperChest', [0, 1.45, 0]);
bone('head', 'neck', [0, 1.54, 0]);
for (const [s, side] of [[1, 'left'], [-1, 'right']]) {
  bone(`${side}Shoulder`, 'upperChest', [0.035 * s, 1.415, 0]);
  bone(`${side}UpperArm`, `${side}Shoulder`, [0.18 * s, 1.41, 0]);
  bone(`${side}LowerArm`, `${side}UpperArm`, [0.45 * s, 1.41, 0]);
  bone(`${side}Hand`, `${side}LowerArm`, [0.7 * s, 1.41, 0]);
  bone(`${side}UpperLeg`, 'hips', [0.09 * s, 0.91, 0]);
  bone(`${side}LowerLeg`, `${side}UpperLeg`, [0.09 * s, 0.5, 0.005]);
  bone(`${side}Foot`, `${side}LowerLeg`, [0.09 * s, 0.085, -0.01]);
  bone(`${side}Toes`, `${side}Foot`, [0.09 * s, 0.02, 0.11]);
}
const BONES = Object.keys(B); // joint order in the skin
const J = Object.fromEntries(BONES.map((n, i) => [n, i]));

// ---------------------------------------------------------------- geometry helpers
// A vertex carries its skin: up to 2 bones with weights.
const v = (p, skin) => ({ p, skin }); // skin: [[bone, w], ...]
const sk = (...pairs) => pairs; // sk(['hips', .5], ['spine', .5])

const parts = {}; // material -> list of triangles [{a,b,c, inside:[x,y,z]}]
function tri(mat, a, b, c, inside) {
  (parts[mat] ||= []).push({ a, b, c, inside });
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Loft along an axis: rings of `n` points. axis 'y' (rings in XZ), 'x' (rings in YZ), 'z' (rings in XY).
 * ring: { c:[x,y,z], r1, r2, skin, shape? } r1/r2 = radii on the two ring axes.
 */
function loft(mat, axis, rings, n, { capStart = true, capEnd = true, phase = 0 } = {}) {
  const pts = rings.map((r) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      let u = Math.cos(a) * r.r1, w = Math.sin(a) * r.r2;
      if (r.shape) [u, w] = r.shape(u, w, a);
      const p = axis === 'y' ? [r.c[0] + u, r.c[1], r.c[2] + w]
        : axis === 'x' ? [r.c[0], r.c[1] + u, r.c[2] + w]
          : [r.c[0] + u, r.c[1] + w, r.c[2]];
      out.push(v(p, r.skin));
    }
    return out;
  });
  for (let k = 0; k < rings.length - 1; k++) {
    const inside = rings[k].c.map((x, i) => (x + rings[k + 1].c[i]) / 2);
    for (let i = 0; i < n; i++) {
      const a = pts[k][i], b = pts[k][(i + 1) % n], c = pts[k + 1][(i + 1) % n], d = pts[k + 1][i];
      tri(mat, a, b, c, inside);
      tri(mat, a, c, d, inside);
    }
  }
  const cap = (k, dirSign) => {
    const r = rings[k];
    const nb = rings[k + dirSign] || r;
    const center = v(r.c, r.skin);
    const inside = r.c.map((x, i) => lerp(x, nb.c[i], 0.5));
    for (let i = 0; i < n; i++) tri(mat, center, pts[k][i], pts[k][(i + 1) % n], inside);
  };
  if (capStart) cap(0, 1);
  if (capEnd) cap(rings.length - 1, -1);
}

/** Low-poly ellipsoid (UV sphere), optional per-vertex shaping and face filter. */
function ellipsoid(mat, c, r, seg, rows, skin, { shape, keep } = {}) {
  const grid = [];
  for (let j = 0; j <= rows; j++) {
    const th = (j / rows) * Math.PI; // 0 top .. PI bottom
    const row = [];
    for (let i = 0; i < seg; i++) {
      const ph = (i / seg) * Math.PI * 2;
      let p = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
      if (shape) p = shape(p);
      row.push(v([c[0] + p[0] * r[0], c[1] + p[1] * r[1], c[2] + p[2] * r[2]], skin));
    }
    grid.push(row);
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < seg; i++) {
      const a = grid[j][i], b = grid[j][(i + 1) % seg], cc = grid[j + 1][(i + 1) % seg], d = grid[j + 1][i];
      const cen = [(a.p[0] + cc.p[0]) / 2, (a.p[1] + cc.p[1]) / 2, (a.p[2] + cc.p[2]) / 2];
      if (keep && !keep(cen)) continue;
      if (j !== 0) tri(mat, a, b, cc, c);
      if (j !== rows - 1) tri(mat, a, cc, d, c);
    }
  }
}

/** Box from 8 corners (skinned), for hands, nose, ears, soles. */
function box(mat, min, max, skin) {
  const P = (x, y, z) => v([x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]], skin);
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const q = (a, b, cc, d) => { tri(mat, a, b, cc, c); tri(mat, a, cc, d, c); };
  const p = [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0), P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)];
  q(p[0], p[1], p[2], p[3]); q(p[4], p[5], p[6], p[7]); q(p[0], p[4], p[7], p[3]);
  q(p[1], p[5], p[6], p[2]); q(p[3], p[2], p[6], p[7]); q(p[0], p[1], p[5], p[4]);
}

// ---------------------------------------------------------------- the human
const SKIN = 'skin', SHIRT = 'shirt', PANTS = 'pants', SHOES = 'shoes', SOLE = 'sole', HAIR = 'hair', EYES = 'eyes', BELT = 'belt';

// Torso: flatter at the back, fuller chest; pants up to the waist, shirt above.
const torsoShape = (frontBoost) => (u, w) => [u, w > 0 ? w * frontBoost : w];
loft(PANTS, 'y', [
  { c: [0, 0.855, 0], r1: 0.12, r2: 0.095, skin: sk(['hips', 1]) },
  { c: [0, 0.93, 0], r1: 0.168, r2: 0.112, skin: sk(['hips', 1]) },
  { c: [0, 1.0, 0], r1: 0.158, r2: 0.105, skin: sk(['hips', 0.7], ['spine', 0.3]) },
], 10, { capEnd: false });
loft(BELT, 'y', [
  { c: [0, 1.0, 0], r1: 0.16, r2: 0.107, skin: sk(['hips', 0.7], ['spine', 0.3]) },
  { c: [0, 1.03, 0], r1: 0.156, r2: 0.105, skin: sk(['hips', 0.5], ['spine', 0.5]) },
], 10, { capStart: false, capEnd: false });
loft(SHIRT, 'y', [
  { c: [0, 1.03, 0], r1: 0.156, r2: 0.105, skin: sk(['hips', 0.5], ['spine', 0.5]) },
  { c: [0, 1.12, 0], r1: 0.152, r2: 0.108, skin: sk(['spine', 1]) },
  { c: [0, 1.22, 0.004], r1: 0.168, r2: 0.112, skin: sk(['spine', 0.3], ['chest', 0.7]), shape: torsoShape(1.12) },
  { c: [0, 1.31, 0.004], r1: 0.172, r2: 0.115, skin: sk(['chest', 0.4], ['upperChest', 0.6]), shape: torsoShape(1.1) },
  { c: [0, 1.395, 0], r1: 0.15, r2: 0.098, skin: sk(['upperChest', 1]) },
  { c: [0, 1.445, 0], r1: 0.085, r2: 0.07, skin: sk(['upperChest', 0.6], ['neck', 0.4]) },
], 10, { capStart: false });

// Neck
loft(SKIN, 'y', [
  { c: [0, 1.42, 0], r1: 0.048, r2: 0.05, skin: sk(['upperChest', 0.5], ['neck', 0.5]) },
  { c: [0, 1.5, 0.004], r1: 0.046, r2: 0.048, skin: sk(['neck', 1]) },
  { c: [0, 1.57, 0.01], r1: 0.05, r2: 0.05, skin: sk(['neck', 0.4], ['head', 0.6]) },
], 7);

// Head: slightly taller than wide, narrower jaw and chin.
const HEAD_C = [0, 1.635, 0.012], HEAD_R = [0.088, 0.112, 0.1];
const headShape = (p) => {
  const [x, y, z] = p;
  let sx = 1, sz = 1;
  if (y < -0.1) { const t = Math.min(1, (-y - 0.1) / 0.9); sx = 1 - 0.35 * t; sz = 1 - 0.1 * t; } // jaw taper
  return [x * sx, y, z * sz + (y < -0.2 && z > 0 ? 0.06 * z : 0)];
};
ellipsoid(SKIN, HEAD_C, HEAD_R, 12, 9, sk(['head', 1]), { shape: headShape });
// Hair: a slightly bigger cap over the top and back of the head.
ellipsoid(HAIR, [HEAD_C[0], HEAD_C[1] + 0.006, HEAD_C[2] - 0.004], [HEAD_R[0] * 1.08, HEAD_R[1] * 1.06, HEAD_R[2] * 1.07], 12, 9, sk(['head', 1]), {
  shape: headShape,
  keep: ([, y, z]) => y > HEAD_C[1] + 0.035 || (z < HEAD_C[2] - 0.03 && y > HEAD_C[1] - 0.06),
});
// Face details: eyes, eyebrows, nose, ears.
for (const s of [1, -1]) {
  box(EYES, [0.026 * s - 0.011, 1.645, 0.097], [0.026 * s + 0.011, 1.657, 0.106], sk(['head', 1]));
  box(HAIR, [0.028 * s - 0.016, 1.666, 0.098], [0.028 * s + 0.016, 1.672, 0.104], sk(['head', 1]));
  box(SKIN, [0.086 * s - 0.01, 1.62, -0.0], [0.086 * s + 0.01, 1.66, 0.025], sk(['head', 1]));
}
loft(SKIN, 'z', [ // nose: small pyramid-ish
  { c: [0, 1.628, 0.1], r1: 0.014, r2: 0.016, skin: sk(['head', 1]) },
  { c: [0, 1.622, 0.122], r1: 0.004, r2: 0.005, skin: sk(['head', 1]) },
], 4, { capStart: false, phase: Math.PI / 4 });

for (const [s, side] of [[1, 'left'], [-1, 'right']]) {
  const L = (n) => `${side}${n}`;
  // Legs (trousers to the ankle)
  loft(PANTS, 'y', [
    { c: [0.088 * s, 0.94, 0], r1: 0.088, r2: 0.09, skin: sk(['hips', 0.4], [L('UpperLeg'), 0.6]) },
    { c: [0.09 * s, 0.8, 0.005], r1: 0.082, r2: 0.085, skin: sk([L('UpperLeg'), 1]) },
    { c: [0.09 * s, 0.63, 0.004], r1: 0.065, r2: 0.068, skin: sk([L('UpperLeg'), 1]) },
    { c: [0.09 * s, 0.5, 0.008], r1: 0.054, r2: 0.058, skin: sk([L('UpperLeg'), 0.5], [L('LowerLeg'), 0.5]) },
    { c: [0.09 * s, 0.37, -0.004], r1: 0.056, r2: 0.06, skin: sk([L('LowerLeg'), 1]) },
    { c: [0.09 * s, 0.2, -0.008], r1: 0.046, r2: 0.048, skin: sk([L('LowerLeg'), 1]) },
    { c: [0.09 * s, 0.11, -0.01], r1: 0.05, r2: 0.052, skin: sk([L('LowerLeg'), 0.6], [L('Foot'), 0.4]) },
  ], 8, { capStart: false });
  // Shoe: lofted along +Z from heel to toe, sole underneath.
  const shoe = (z, w, h, y0, skin) => ({ c: [0.09 * s, y0 + h / 2, z], r1: w, r2: h / 2, skin, shape: (u, ww) => [u, Math.max(ww, -h / 2 + 0.005)] });
  loft(SHOES, 'z', [
    shoe(-0.055, 0.04, 0.09, 0.02, sk([L('Foot'), 1])),
    shoe(-0.01, 0.048, 0.1, 0.02, sk([L('Foot'), 1])),
    shoe(0.07, 0.052, 0.07, 0.02, sk([L('Foot'), 0.5], [L('Toes'), 0.5])),
    shoe(0.15, 0.046, 0.05, 0.02, sk([L('Toes'), 1])),
    shoe(0.185, 0.03, 0.035, 0.02, sk([L('Toes'), 1])),
  ], 8, { phase: Math.PI / 8 });
  box(SOLE, [0.09 * s - 0.05, 0.0, -0.065], [0.09 * s + 0.05, 0.022, 0.19], sk([L('Foot'), 0.6], [L('Toes'), 0.4]));

  // Arms: short sleeve, then skin. Rings in the YZ plane along X.
  const ax = (x) => x * s;
  loft(SHIRT, 'x', [
    { c: [ax(0.11), 1.39, 0], r1: 0.075, r2: 0.072, skin: sk(['upperChest', 0.7], [L('UpperArm'), 0.3]) },
    { c: [ax(0.17), 1.4, 0], r1: 0.066, r2: 0.064, skin: sk(['upperChest', 0.25], [L('UpperArm'), 0.75]) },
    { c: [ax(0.22), 1.405, 0], r1: 0.06, r2: 0.058, skin: sk([L('UpperArm'), 1]) },
    { c: [ax(0.3), 1.405, 0], r1: 0.056, r2: 0.054, skin: sk([L('UpperArm'), 1]) },
  ], 8, { capStart: false, capEnd: false });
  loft(SKIN, 'x', [
    { c: [ax(0.3), 1.405, 0], r1: 0.048, r2: 0.046, skin: sk([L('UpperArm'), 1]) },
    { c: [ax(0.43), 1.41, 0], r1: 0.04, r2: 0.04, skin: sk([L('UpperArm'), 0.6], [L('LowerArm'), 0.4]) },
    { c: [ax(0.47), 1.41, 0], r1: 0.038, r2: 0.04, skin: sk([L('UpperArm'), 0.3], [L('LowerArm'), 0.7]) },
    { c: [ax(0.58), 1.41, 0.002], r1: 0.037, r2: 0.038, skin: sk([L('LowerArm'), 1]) },
    { c: [ax(0.69), 1.41, 0], r1: 0.026, r2: 0.032, skin: sk([L('LowerArm'), 0.6], [L('Hand'), 0.4]) },
  ], 8, { capStart: false });
  // Hand: flattened block + thumb.
  box(SKIN, [Math.min(ax(0.69), ax(0.86)), 1.392, -0.038], [Math.max(ax(0.69), ax(0.86)), 1.422, 0.04], sk([L('Hand'), 1]));
  box(SKIN, [Math.min(ax(0.71), ax(0.77)), 1.39, 0.035], [Math.max(ax(0.71), ax(0.77)), 1.414, 0.06], sk([L('Hand'), 1]));
}

// ---------------------------------------------------------------- flatten to GLB data
const MATERIALS = {
  skin: [0.86, 0.62, 0.48], shirt: [0.18, 0.42, 0.72], pants: [0.2, 0.23, 0.29], belt: [0.25, 0.17, 0.11],
  shoes: [0.93, 0.93, 0.92], sole: [0.3, 0.3, 0.32], hair: [0.22, 0.15, 0.1], eyes: [0.08, 0.08, 0.09],
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const primitives = [];
for (const [mat, tris] of Object.entries(parts)) {
  const pos = [], nor = [], jnt = [], wgt = [];
  for (const t of tris) {
    let { a, b, c } = t;
    let n = cross(sub(b.p, a.p), sub(c.p, a.p));
    const cen = [(a.p[0] + b.p[0] + c.p[0]) / 3, (a.p[1] + b.p[1] + c.p[1]) / 3, (a.p[2] + b.p[2] + c.p[2]) / 3];
    if (dot(n, sub(cen, t.inside)) < 0) { [b, c] = [c, b]; n = n.map((x) => -x); } // face outwards
    const len = Math.hypot(...n);
    if (len < 1e-12) continue; // degenerate
    n = n.map((x) => x / len);
    for (const vv of [a, b, c]) {
      pos.push(...vv.p);
      nor.push(...n);
      const s = [...vv.skin, ['hips', 0], ['hips', 0], ['hips', 0]].slice(0, 4);
      const total = s.reduce((acc, [, w]) => acc + w, 0);
      jnt.push(...s.map(([bn]) => J[bn]));
      wgt.push(...s.map(([, w]) => w / total));
    }
  }
  primitives.push({ mat, pos, nor, jnt, wgt });
}

// ---------------------------------------------------------------- GLB writer
const bin = [];
let binLen = 0;
const bufferViews = [], accessors = [];
function addView(typed, target) {
  const pad = (4 - (binLen % 4)) % 4;
  if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length, ...(target ? { target } : {}) });
  bin.push(buf);
  binLen += buf.length;
  return bufferViews.length - 1;
}
function addAccessor(typed, type, componentType, count, extra = {}) {
  const view = addView(typed, extra.target);
  delete extra.target;
  accessors.push({ bufferView: view, componentType, count, type, ...extra });
  return accessors.length - 1;
}
const minmax = (arr) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], arr[i + k]); max[k] = Math.max(max[k], arr[i + k]); }
  return { min, max };
};

const materials = [], gltfPrims = [];
let triCount = 0;
for (const p of primitives) {
  const count = p.pos.length / 3;
  triCount += count / 3;
  const POSITION = addAccessor(new Float32Array(p.pos), 'VEC3', 5126, count, { ...minmax(p.pos), target: 34962 });
  const NORMAL = addAccessor(new Float32Array(p.nor), 'VEC3', 5126, count, { target: 34962 });
  const JOINTS_0 = addAccessor(new Uint8Array(p.jnt), 'VEC4', 5121, count, { target: 34962 });
  const WEIGHTS_0 = addAccessor(new Float32Array(p.wgt), 'VEC4', 5126, count, { target: 34962 });
  const col = MATERIALS[p.mat].map(srgbToLinear);
  materials.push({ name: p.mat, pbrMetallicRoughness: { baseColorFactor: [...col, 1], metallicFactor: 0, roughnessFactor: p.mat === 'eyes' ? 0.3 : 0.85 } });
  gltfPrims.push({ attributes: { POSITION, NORMAL, JOINTS_0, WEIGHTS_0 }, material: materials.length - 1, mode: 4 });
}

// Nodes: 0 = Root, 1.. = bones (in BONES order), last = body mesh.
const nodes = [{ name: 'Root', children: [1] }];
for (const name of BONES) {
  const b = B[name];
  const parentPos = b.parent ? B[b.parent].pos : [0, 0, 0];
  nodes.push({ name: name[0].toUpperCase() + name.slice(1), translation: sub(b.pos, parentPos).map((x) => +x.toFixed(5)), children: [] });
}
BONES.forEach((name, i) => { const p = B[name].parent; if (p) nodes[J[p] + 1].children.push(i + 1); });
for (const n of nodes) if (n.children && !n.children.length) delete n.children;
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach((name, i) => {
  const [x, y, z] = B[name].pos;
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], i * 16);
});
const ibmAcc = addAccessor(ibm, 'MAT4', 5126, BONES.length);
nodes.push({ name: 'Body', mesh: 0, skin: 0 });
const meshNode = nodes.length - 1;

const humanBones = Object.fromEntries(BONES.map((name, i) => [name, { node: i + 1 }]));
const gltf = {
  asset: { version: '2.0', generator: 'opengeoworld gen-avatar.mjs' },
  extensionsUsed: ['VRMC_vrm'],
  scene: 0,
  scenes: [{ nodes: [0, meshNode] }],
  nodes,
  meshes: [{ name: 'Body', primitives: gltfPrims }],
  skins: [{ joints: BONES.map((_, i) => i + 1), inverseBindMatrices: ibmAcc, skeleton: 1 }],
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: 0 }],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'opengeoworld human',
        version: '1',
        authors: ['opengeoworld'],
        copyrightInformation: 'opengeoworld contributors, MIT',
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        otherLicenseUrl: 'https://opensource.org/license/mit',
        avatarPermission: 'everyone',
        allowExcessivelyViolentUsage: true,
        allowExcessivelySexualUsage: false,
        commercialUsage: 'corporation',
        allowPoliticalOrReligiousUsage: true,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'unnecessary',
        allowRedistribution: true,
        modification: 'allowModificationRedistribution',
      },
      humanoid: { humanBones },
    },
  },
};
const binBuf = Buffer.concat(bin);
gltf.buffers[0].byteLength = binBuf.length;
let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const binPadded = Buffer.concat([binBuf, Buffer.alloc((4 - (binBuf.length % 4)) % 4)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
const glb = Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(binPadded, 0x004e4942)]);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'human.vrm'), glb);
copyFileSync(join(OUT, 'human.vrm'), join(OUT, 'human-lod.vrm'));
console.log(`human.vrm: ${triCount} triangles, ${primitives.length} materials, ${BONES.length} bones, ${(glb.length / 1024).toFixed(0)} KB`);
