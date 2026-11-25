// Pitched roofs. A roof is the lower envelope of a few planes (one per roof face):
//   height(p) = eaves + min_k f_k(p),   f_k linear in the footprint plane (east, north).
// That covers flat (no planes), skillion (1), gabled (2), hipped/pyramidal (one per edge of a
// convex footprint, or the 4 sides of its oriented bounding box). Each face is the part of the
// footprint where its plane is the lowest: a convex clip by half-planes, so faces are exact planar
// polygons and ridges are crisp. Walls take their top from the same function, so gable ends are
// real triangular walls.

// ---------------------------------------------------------------- 2D helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function polygonArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area oriented bounding box: { o (centre), u (long axis), v (short axis), L, W } with L ≥ W. */
export function orientedBox(ring) {
  const hull = convexHull(ring);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const e = sub(hull[(i + 1) % hull.length], hull[i]);
    const len = Math.hypot(e[0], e[1]);
    if (len < 1e-6) continue;
    const u = [e[0] / len, e[1] / len], v = [-u[1], u[0]];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of hull) { const x = dot(p, u), y = dot(p, v); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, u, v, x0, x1, y0, y1 };
  }
  if (!best) return null;
  let { u, v, x0, x1, y0, y1 } = best;
  if (x1 - x0 < y1 - y0) { [u, v] = [v, [-u[0], -u[1]]]; [x0, x1, y0, y1] = [y0, y1, -x1, -x0]; } // long axis = u
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { o: [u[0] * cx + v[0] * cy, u[1] * cx + v[1] * cy], u, v, L: x1 - x0, W: y1 - y0, area: best.area, hullArea: Math.abs(polygonArea(hull)) };
}

/** Clip a polygon by the half-plane fn(p) <= 0 (fn linear: {a, b, c} → a·e + b·n + c). */
function clipHalf(poly, f) {
  const val = (p) => f.a * p[0] + f.b * p[1] + f.c;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const vp = val(p), vq = val(q);
    if (vp <= 1e-9) out.push(p);
    if ((vp <= 1e-9) !== (vq <= 1e-9)) { const t = vp / (vp - vq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  }
  return out;
}
const lin = (a, b, c) => ({ a, b, c });
const evalF = (f, p) => f.a * p[0] + f.b * p[1] + f.c;
/** Linear function = s · (distance from the line through `p0` with inward unit normal `n`). */
const distFn = (n, p0, s) => lin(n[0] * s, n[1] * s, -dot(n, p0) * s);

// ---------------------------------------------------------------- roof
/**
 * Decide and build the roof of one building.
 * outer: CCW ring [[e,n]…]; holes: rings; shape: 'auto' | 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'skillion';
 * rise: roof height above the eaves (m, 0 = unknown/flat).
 * Returns { kind, rise, fns, faces: [{ poly, fn|null }], heightAt(p) (above eaves), wallTop(p0, p1) → [[t, h]…] }.
 */
export function makeRoof(outer, holes, shape, rise, minFill = 0.8) { // minFill: how box-like a non-convex footprint must be (houses: L-shapes too)
  const flat = (kind = 'flat') => ({ kind, rise: 0, fns: [], faces: [{ poly: outer, fn: null, holes }], heightAt: () => 0, wallTop: () => [[0, 0], [1, 0]] });
  if (shape === 'flat' || holes.length || !(rise > 0.8 || rise < 0)) return flat();

  const box = orientedBox(outer);
  if (!box || box.W < 3) return flat();
  if (rise < 0) rise = Math.min(4, box.W * 0.35); // shape known, height not: a plausible pitch
  const area = Math.abs(polygonArea(outer));
  const convex = area / box.hullArea > 0.97;
  const rectish = area / box.area > minFill;
  if (!convex && !rectish) return flat();
  rise = Math.min(rise, box.W * 0.7, 12); // no needle roofs

  let kind = shape;
  if (kind === 'auto') kind = box.L / box.W >= 1.8 ? 'gabled' : 'hipped';
  if (kind === 'pyramidal') kind = 'hipped';
  if (!['gabled', 'hipped', 'skillion'].includes(kind)) kind = 'hipped'; // dome, mansard… → hipped

  const { o, u, v, L, W } = box;
  const vNeg = [-v[0], -v[1]], uNeg = [-u[0], -u[1]];
  const at = (x, y) => [o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y];
  let fns;
  if (kind === 'skillion') {
    fns = [distFn(v, at(0, -W / 2), rise / W)]; // rises across the short side
  } else if (kind === 'gabled') {
    const s = rise / (W / 2);
    fns = [distFn(v, at(0, -W / 2), s), distFn(vNeg, at(0, W / 2), s)];
  } else if (convex) {
    // hipped on the real footprint: one plane per edge (slope set so the ridge reaches `rise`)
    fns = [];
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i], q = outer[(i + 1) % outer.length];
      const e = sub(q, p), len = Math.hypot(e[0], e[1]);
      if (len < 0.3) continue;
      fns.push(distFn([-e[1] / len, e[0] / len], p, 1)); // inward normal of a CCW ring
    }
  } else {
    fns = [distFn(v, at(0, -W / 2), 1), distFn(vNeg, at(0, W / 2), 1), distFn(u, at(-L / 2, 0), 1), distFn(uNeg, at(L / 2, 0), 1)];
  }

  // faces: where each plane is the lowest
  const faceOf = (k) => {
    let poly = outer;
    for (let j = 0; j < fns.length && poly.length >= 3; j++) {
      if (j === k) continue;
      poly = clipHalf(poly, lin(fns[k].a - fns[j].a, fns[k].b - fns[j].b, fns[k].c - fns[j].c));
    }
    return poly;
  };
  let faces = fns.map((fn, k) => ({ poly: faceOf(k), fn })).filter((f) => f.poly.length >= 3 && Math.abs(polygonArea(f.poly)) > 0.05);

  if (kind === 'hipped') { // scale the unit slopes so the highest point (a face vertex) is at `rise`
    let top = 0;
    for (const f of faces) for (const p of f.poly) top = Math.max(top, evalF(f.fn, p));
    if (top < 0.5) return flat();
    const s = rise / top;
    fns = fns.map((f) => lin(f.a * s, f.b * s, f.c * s));
    faces = faces.map((f, i) => ({ poly: f.poly, fn: lin(f.fn.a * s, f.fn.b * s, f.fn.c * s) }));
  }

  const heightAt = (p) => Math.max(0, Math.min(...fns.map((f) => evalF(f, p))));
  // Along a wall p0→p1 the roof height is piecewise linear; breakpoints where two planes cross.
  const wallTop = (p0, p1) => {
    const ts = new Set([0, 1]);
    for (let i = 0; i < fns.length; i++) for (let j = i + 1; j < fns.length; j++) {
      const a0 = evalF(fns[i], p0) - evalF(fns[j], p0), a1 = evalF(fns[i], p1) - evalF(fns[j], p1);
      if ((a0 > 0) !== (a1 > 0) && Math.abs(a0 - a1) > 1e-9) { const t = a0 / (a0 - a1); if (t > 1e-4 && t < 1 - 1e-4) ts.add(t); }
    }
    return [...ts].sort((a, b) => a - b).map((t) => [t, heightAt([p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])])]);
  };
  return { kind, rise, fns, faces, heightAt, wallTop };
}
