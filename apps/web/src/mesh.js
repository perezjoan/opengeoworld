// Geometry of a place: terrain grid, buildings with styled facades, trees and water.
// Frame: glTF Y-up, X = east, -Z = north, metres, origin = picked point at ground level.
//
// Every mesh is indexed and has position/normal/uv (the world engine merges all meshes of the
// place into one collision mesh, which requires identical attributes). Water is a separate mesh
// named "water": the web app drops it from the GLB handed to the world, which draws its own
// animated water from userData.water (and doesn't collide with it).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { STYLES, chooseStyle, createFacadeKit } from './facades.js';
import { clipToSquare, inPolygon, polygonIndex, bbox, ringArea, waterLevels, waterMesh, plantTrees } from './nature.js';
import { makeRoof } from './roofs.js';
import { buildRoads, createRoadKit } from './roads.js';

// Half-size of the square terrain (and imagery) around the picked point.
export const terrainHalfSize = (radius) => radius * 1.1;

const GROUND_FLOOR = 4.2; // shopfront band height (m)

/**
 * Bridge decks. Sets r.deck = [zStart, zEnd] (terrain metres) on every bridge piece, and r.ramp =
 * [zStart|null, zEnd|null] on the streets that meet a bridge (roads.js lifts them towards the deck).
 *
 * Bridges come in several pieces: IGN cuts its road sections at junctions and at commune /
 * arrondissement boundaries, which in Paris run down the middle of the Seine. A piece running
 * straight between the ground at its own ends dips into the river where it was cut. So the pieces
 * are joined into networks by their shared ends:
 *  - an end that meets ordinary streets takes the ground there, or the streets' ground 25 m in (or
 *    at their far end) when that is higher: the elevation model has no bridges, it shows the river
 *    under them and the hole runs onto the banks, so the ground right at the end is often the water
 *    or halfway down the quay wall;
 *  - the ends where only bridge pieces meet (or with no street at all) are free and take the
 *    length-weighted average of their neighbours: the deck runs straight from bank to bank.
 * The streets meeting a bridge dip into that same hole; roads.js ramps them from the deck height
 * down to their own ground (r.ramp).
 */
function assignBridgeDecks(lines, ground, waterAt) {
  const bridges = lines.filter((r) => r.bridge && !r.tunnel && r.line.length >= 2);
  if (!bridges.length) return;
  const SNAP = 1.5;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < SNAP;
  const nodes = []; // { p, z, wet, fixed, nb: [[node, length]], streets: [[road, atStart]] }
  const nodeAt = (p) => {
    let n = nodes.find((m) => near(m.p, p));
    if (!n) nodes.push((n = { p, nb: [], streets: [] }));
    return n;
  };
  const length = (L) => { let s = 0; for (let i = 1; i < L.length; i++) s += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]); return Math.max(1, s); };
  const ends = bridges.map((r) => {
    const a = nodeAt(r.line[0]), b = nodeAt(r.line[r.line.length - 1]), len = length(r.line);
    a.nb.push([b, len]); b.nb.push([a, len]);
    return [a, b];
  });
  for (const r of lines) {
    if (r.bridge || r.tunnel || r.line.length < 2) continue;
    for (const n of nodes) {
      if (near(r.line[0], n.p)) n.streets.push([r, true]);
      else if (near(r.line[r.line.length - 1], n.p)) n.streets.push([r, false]);
    }
  }
  const along = (L, d) => { // the point d metres along L (its last point if L is shorter)
    for (let i = 1; i < L.length; i++) {
      const len = Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]);
      if (len >= d) return [L[i - 1][0] + ((L[i][0] - L[i - 1][0]) * d) / len, L[i - 1][1] + ((L[i][1] - L[i - 1][1]) * d) / len];
      d -= len;
    }
    return L[L.length - 1];
  };
  for (const n of nodes) {
    n.z = ground(n.p[0], n.p[1]);
    n.wet = !!waterAt(n.p[0], n.p[1]);
    n.fixed = !n.wet && (n.streets.length > 0 || n.nb.length === 1);
    let z = -Infinity;
    for (const [r, atStart] of n.streets) {
      const q = along(atStart ? r.line : [...r.line].reverse(), 25);
      if (!waterAt(q[0], q[1])) z = Math.max(z, ground(q[0], q[1]));
    }
    // by the water: the bank's top too, the upper quartile of the land 15-25 m around (footbridges
    // often end on stairs or paths, with no street to follow onto the quay)
    const ring = [];
    let byWater = n.wet;
    for (const rad of [15, 25]) for (let k = 0; k < 16; k++) {
      const x = n.p[0] + rad * Math.cos((k * Math.PI) / 8), y = n.p[1] + rad * Math.sin((k * Math.PI) / 8);
      if (waterAt(x, y)) byWater = true; else ring.push(ground(x, y));
    }
    if (byWater && ring.length >= 4 && (n.streets.length || n.nb.length === 1)) z = Math.max(z, ring.sort((a, b) => a - b)[Math.floor(ring.length * 0.75)]);
    if (z > -Infinity) { n.z = n.wet ? z : Math.max(n.z, z); n.fixed = true; }
  }
  // networks with no fixed end (both banks cut over the water, or a bridge cut at the edge of the
  // area): the highest street ground near their ends, else the highest ground they touch
  const seen = new Set();
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const net = [start];
    seen.add(start);
    for (let i = 0; i < net.length; i++) for (const [m] of net[i].nb) if (!seen.has(m)) { seen.add(m); net.push(m); }
    if (net.some((n) => n.fixed)) continue;
    let top = Math.max(...net.map((n) => n.z));
    for (const n of net) for (const [r, atStart] of n.streets) {
      const L = atStart ? r.line : [...r.line].reverse(), q = L[Math.min(L.length - 1, 1)];
      if (!waterAt(q[0], q[1])) top = Math.max(top, ground(q[0], q[1]));
    }
    net.forEach((n) => { n.z = top; n.fixed = true; });
  }
  // the free ends: length-weighted average of their neighbours (straight decks along chains)
  const free = nodes.filter((n) => !n.fixed);
  for (let it = 0; it < 200 && free.length; it++) {
    for (const n of free) {
      let s = 0, w = 0;
      for (const [m, len] of n.nb) { s += m.z / len; w += 1 / len; }
      n.z = s / w;
    }
  }
  bridges.forEach((r, i) => { r.deck = [ends[i][0].z, ends[i][1].z]; });
  for (const n of nodes) for (const [r, atStart] of n.streets) {
    r.ramp ||= [null, null];
    r.ramp[atStart ? 0 : 1] = Math.max(r.ramp[atStart ? 0 : 1] ?? -Infinity, n.z);
  }
}

/**
 * (x, y) → true where a tree would stand on a carriageway or a railway: within the road's half width
 * plus 0.3 m, so trunks stand on the sidewalk, not on the kerb. Mapped trees and planted woods are
 * often a few metres off the road centrelines (two datasets, two surveys); footways, paths and
 * squares keep their trees. A grid of segments keeps it fast with thousands of roads and trees.
 */
function carriagewayIndex(lines, margin = 0.3, keep = () => true) {
  const CELL = 20, grid = new Map();
  const segs = [];
  for (const r of lines) {
    if (r.tunnel || r.line.length < 2 || r.kind === 'pedestrian' || r.kind === 'footway' || r.kind === 'path') continue;
    if (!keep(r)) continue;
    const reach = r.width / 2 + margin + (margin > 0.3 && (r.sides?.left || r.sides?.right) ? 2.2 : 0);
    for (let i = 0; i < r.line.length - 1; i++) {
      const [ax, ay] = r.line[i], [bx, by] = r.line[i + 1];
      const s = segs.push([ax, ay, bx, by, reach]) - 1;
      for (let gx = Math.floor((Math.min(ax, bx) - reach) / CELL); gx <= Math.floor((Math.max(ax, bx) + reach) / CELL); gx++) {
        for (let gy = Math.floor((Math.min(ay, by) - reach) / CELL); gy <= Math.floor((Math.max(ay, by) + reach) / CELL); gy++) {
          const k = gx + ',' + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(s);
        }
      }
    }
  }
  return (x, y) => {
    for (const s of grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || []) {
      const [ax, ay, bx, by, reach] = segs[s];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < reach) return true;
    }
    return false;
  };
}

/** (x, y) → true within reachOf(r) metres of a line r (null: skip it). Grid of segments, like above. */
function corridorIndex(lines, reachOf) {
  const CELL = 20, grid = new Map(), segs = [];
  for (const r of lines) {
    if (r.tunnel || r.line.length < 2) continue;
    const reach = reachOf(r);
    if (reach == null) continue;
    for (let i = 0; i < r.line.length - 1; i++) {
      const [ax, ay] = r.line[i], [bx, by] = r.line[i + 1];
      const s = segs.push([ax, ay, bx, by, reach]) - 1;
      for (let gx = Math.floor((Math.min(ax, bx) - reach) / CELL); gx <= Math.floor((Math.max(ax, bx) + reach) / CELL); gx++) {
        for (let gy = Math.floor((Math.min(ay, by) - reach) / CELL); gy <= Math.floor((Math.max(ay, by) + reach) / CELL); gy++) {
          const k = gx + ',' + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(s);
        }
      }
    }
  }
  return (x, y) => {
    for (const s of grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || []) {
      const [ax, ay, bx, by, reach] = segs[s];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < reach) return true;
    }
    return false;
  };
}
// a road's full width: carriageway and sidewalks
const roadReach = (r, extra) => r.width / 2 + (r.sides?.left || r.sides?.right ? 2.2 : 0) + extra;

/** Vegetation kinds (IGN natures and OSM kinds) → how trees are planted there. */
function plantingFor(kind) {
  const k = kind.toLowerCase();
  if (/conif/.test(k)) return { spacing: 7, height: [12, 22], kinds: ['conifer'] };
  if (/mixte/.test(k)) return { spacing: 7, height: [10, 20], kinds: ['conifer', 'broad'] };
  if (/for[eê]t|bois|wood/.test(k)) return { spacing: 7, height: [10, 20], kinds: ['broad', 'broad', 'conifer'] };
  if (/haie/.test(k)) return { spacing: 4, height: [3, 6], kinds: ['small'] };
  if (/verger|orchard/.test(k)) return { spacing: 8, height: [4, 6], kinds: ['small'] };
  if (/park|garden/.test(k)) return { spacing: 13, height: [8, 16], kinds: ['broad', 'small'] };
  if (/lande|scrub/.test(k)) return { spacing: 7, height: [2, 4], kinds: ['small'] };
  return null; // grass, vines, etc.: no trees
}

export function buildModel({ buildings, proj, ground, radius, ortho = null, nature = null, roads = null, rails = null, facades = null, terrainRes = 128, guessRoofs = true }) {
  const group = new THREE.Group();
  group.name = 'opengeoworld';
  const size = terrainHalfSize(radius);
  const kit = createFacadeKit(facades); // facades: the photo library (loadFacadeLibrary) or null
  plainCache.clear();
  const toLocalPoly = (p) => {
    const outer = clipToSquare(ringToLocal(p.outer, proj), size);
    const holes = (p.holes || []).map((h) => clipToSquare(ringToLocal(h, proj), size)).filter((h) => h.length >= 3);
    return { outer, holes, kind: p.kind || '' };
  };

  // ---- water: local polygons + a level each; the terrain is carved below it
  const waters = waterLevels((nature?.water || []).map(toLocalPoly).filter((w) => w.outer.length >= 3 && Math.abs(ringArea(w.outer)) > 30), ground);
  const waterBoxes = waters.map((w) => bbox(w.outer));
  const waterAt = (e, n) => {
    for (let i = 0; i < waters.length; i++) {
      const b = waterBoxes[i];
      if (e >= b[0] && e <= b[2] && n >= b[1] && n <= b[3] && inPolygon(e, n, waters[i])) return waters[i];
    }
    return null;
  };
  // A bridge deck runs straight between the ground at its two ends (as roads.js builds it): water it
  // crosses must stay a few metres below. Coarse terrain (a river in a gorge smoothed out) otherwise
  // puts the water above the bridges.
  const toLocalLine = (r) => ({ ...r, line: r.line.map(([lat, lon]) => proj.toLocal(lat, lon)) });
  const localRoads = (roads || []).map(toLocalLine), localRails = (rails || []).map(toLocalLine);
  assignBridgeDecks(localRoads, ground, waterAt);
  assignBridgeDecks(localRails, ground, waterAt);
  if (waters.length) {
    for (const r of [...localRoads, ...localRails]) {
      if (!r.bridge || r.line.length < 2) continue;
      const L = r.line, cum = [0];
      for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]));
      const total = cum[cum.length - 1] || 1, [z0, z1] = r.deck;
      for (let i = 0; i < L.length - 1; i++) {
        const len = cum[i + 1] - cum[i], steps = Math.max(1, Math.ceil(len / 2));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps, x = L[i][0] + (L[i + 1][0] - L[i][0]) * t, y = L[i][1] + (L[i + 1][1] - L[i][1]) * t;
          const w = waterAt(x, y);
          if (w) w.level = Math.min(w.level, z0 + ((z1 - z0) * (cum[i] + len * t)) / total - 3.5);
        }
      }
    }
  }
  const carved = (e, n) => { const w = waterAt(e, n); const g = ground(e, n); return w ? Math.min(g, w.level - 1.2) : g; };

  // ---- terrain (orthophoto or flat colour)
  let groundMat, photoRoof = null;
  if (ortho) {
    const tex = new THREE.CanvasTexture(ortho);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.name = 'ortho';
    tex.userData.mimeType = 'image/jpeg'; // GLTFExporter: JPEG instead of PNG -> much smaller GLB
    // Slightly darkened: the world's lighting and tone mapping wash bright photos out (not the
    // satellite mosaic, which is dark already). Roofs use the photo only when it is sharp enough to
    // show them (aerial photos, ~1 m or better); a 10 m satellite pixel just smears dark blobs on them.
    groundMat = new THREE.MeshStandardMaterial({ map: tex, color: ortho.dark ? 0xffffff : 0xbdbdbd, roughness: 1 });
    if ((ortho.sourceRes ?? ortho.metresPerPixel) <= 1.2) photoRoof = groundMat;
    groundMat.name = 'ortho';
  } else {
    groundMat = new THREE.MeshStandardMaterial({ color: 0x6b7d5c, roughness: 1 });
    groundMat.name = 'ground';
  }
  // Banks (quays, river banks, lake shores) are cut exactly where they cross the grid, with a
  // vertical stone wall between the land and the carved bed (see buildTerrain).
  const banks = !waters.length ? null : {
    waterAt,
    low: (w, e, n) => Math.min(ground(e, n), w.level - 1.2),
    // the land's edge: the higher of here and a little further from the water (a crisp quay top,
    // not the half-slope a 1 m model has right at the wall)
    top: (e, n, dx, dy) => Math.max(ground(e, n), ground(e + dx * 1.5, n + dy * 1.5)),
  };
  const quayMat = new THREE.MeshStandardMaterial({ color: 0x9b968b, roughness: 0.92 });
  quayMat.name = 'quay';
  // ramps (stretches of road climbing more than 1.5 m in 20 m: down to a lower quay, into an
  // underpass) keep their own ground: the quay walls are not cut across them
  const ramps = [];
  for (const r of localRoads) {
    if (r.bridge || r.tunnel || r.line.length < 2) continue;
    const L = r.line, pts = [];
    for (let i = 1; i < L.length; i++) {
      const len = Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]), k = Math.max(1, Math.ceil(len / 5));
      for (let t = 0; t < k; t++) pts.push([L[i - 1][0] + ((L[i][0] - L[i - 1][0]) * t) / k, L[i - 1][1] + ((L[i][1] - L[i - 1][1]) * t) / k]);
    }
    pts.push(L[L.length - 1]);
    const h = pts.map(([e, n]) => ground(e, n)), steep = new Array(pts.length).fill(false);
    for (let i = 0; i + 4 < h.length; i++) if (Math.abs(h[i + 4] - h[i]) > 1.5) for (let k = i; k <= i + 4; k++) steep[k] = true;
    for (let i = 0; i < pts.length; i++) {
      if (!steep[i]) continue;
      let j = i;
      while (j + 1 < pts.length && steep[j + 1]) j++;
      if (j > i) ramps.push({ ...r, line: pts.slice(i, j + 1) });
      i = j;
    }
  }
  // (plus a terrain cell: no vertex beside a ramp goes onto a shelf above or below it)
  const onRamp = corridorIndex(ramps, (r) => roadReach(r, 0.6 + 2 * size / terrainRes));
  // streets and paths: walls are cut beside them, never across them (see buildTerrain)
  const onRoad = corridorIndex([...localRoads, ...localRails].filter((r) => !r.bridge), (r) => roadReach(r, 0.3));
  const terrain = buildTerrain(carved, size, terrainRes, groundMat, banks, quayMat, onRamp, onRoad);
  group.add(terrain.mesh);
  if (terrain.walls) group.add(terrain.walls);
  const terrainAt = terrain.heightAt; // height of the terrain mesh itself (roads sit on it)

  // ---- buildings
  const parts = new Map(); // material -> { pos, uv }
  const part = (mat) => { if (!parts.has(mat)) parts.set(mat, { pos: [], uv: [] }); return parts.get(mat); };
  const footprints = [];
  let kept = 0, pitched = 0;
  // where each thing comes from, for the build report (and the GLB): measured / mapped / estimated / generated
  const facts = { heights: { measured: 0, mapped: 0, estimated: 0 }, roofs: { measured: 0, mapped: 0, guessed: 0, flat: 0 } };
  // Which buildings touch another one (row houses, city blocks): a free-standing small building may be
  // a house, an attached one in a generic OSM block is more likely a townhouse with a flat roof.
  const attached = touchingBuildings(buildings);
  const exportBuildings = []; // what was built, per building, for the GeoJSON export
  for (const [bi, b] of buildings.entries()) {
    let outer = ringToLocal(b.outer, proj);
    if (outer.length < 3) continue;
    const c = centroid(outer);
    if (Math.hypot(c[0], c[1]) > radius) continue;
    let holes = b.holes.map((h) => ringToLocal(h, proj)).filter((h) => h.length >= 3);
    if (signedArea(outer) < 0) reverseRing(outer);          // outer ring CCW
    holes = holes.map((h) => (signedArea(h) > 0 ? reverseRing(h) : h)); // holes CW

    let gMin = Infinity;
    for (const [e, n] of outer) gMin = Math.min(gMin, ground(e, n));
    // a building part raised above the ground (tower setbacks, passages): starts at minHeight
    const minH = b.minHeight > 0 ? b.minHeight : 0;
    const base = minH ? gMin + minH : gMin - 1; // sink 1 m so walls never float on slopes
    gMin += minH;                    // from here on, heights count from the part's own base
    const { style, house, material, pick, shopPick, shop, heritage, wallColour, roofKind, roofColour } = chooseStyle(b, c[0], c[1], Math.abs(signedArea(outer)), attached.has(bi));
    // Roof: IGN gives eaves height + roof rise; OSM gives total height + roof shape/height. A house
    // whose data says nothing about its roof gets a pitched one (rise -1: shape known, height not).
    let roofShape = b.roofShape || 'auto', roofRise = b.roofRise ?? 0;
    const guessed = guessRoofs && house && !(roofRise > 0) && (roofShape === 'auto' || (roofShape === 'flat' && !b.tags?.['roof:shape']));
    if (guessed) { roofShape = 'auto'; roofRise = -1; }
    const roof = makeRoof(outer, holes, roofShape, roofRise, house ? 0.55 : 0.8);
    const eavesH = b.heightIsTotal && roof.rise > 0 ? Math.max(2.5, b.height - roof.rise) : b.height;
    const top = gMin + eavesH;       // eaves (flat roof: the roof itself)
    if (roof.rise > 0) pitched++;
    facts.heights[b.heightSource || 'mapped']++;
    const roofSource = roof.rise <= 0 ? 'flat' : guessed ? 'guessed' : b.roofRise > 0 && !b.tags?.['roof:shape'] ? 'measured' : 'mapped';
    facts.roofs[roofSource]++;
    exportBuildings.push({
      outer: b.outer, holes: b.holes,
      ground: gMin - minH, // lowest ground under the outline, model metres
      height: +eavesH.toFixed(2), minHeight: minH, roofRise: +Math.max(0, roof.rise).toFixed(2), roofShape: roof.rise > 0 ? (b.roofShape && b.roofShape !== 'auto' ? b.roofShape : 'pitched') : 'flat',
      heightSource: b.heightSource || 'mapped', roofSource, floors: b.floors || null,
      style, house: !!house, heritage: !!heritage, usage: b.tags?.usage || b.tags?.building || null,
    });
    const facade = kit.facade(style, pick, wallColour, material);
    // Floor height from the real floor count when known, so windows line up with floors.
    const floorH = b.floors > 0 ? THREE.MathUtils.clamp(eavesH / b.floors, 2.6, 4.2) : heritage ? 6 : style === 'industrial' ? 5 : 3;
    const shopOk = shop && !minH && eavesH >= GROUND_FLOOR + 3;
    const shopTile = shopOk && kit.shop(shopPick, GROUND_FLOOR);
    for (const [ri, ring] of [outer, ...holes].entries()) {
      const r = ri === 0 ? roof : null; // courtyards: roofs over holes are always flat
      if (shopOk) {
        const split = gMin + GROUND_FLOOR;
        addWalls(ring, base, split, gMin, GROUND_FLOOR, shopTile.bay, part(shopTile.material));
        addWalls(ring, split, top, split, floorH, facade.bay, part(facade.material), r);
      } else {
        addWalls(ring, base, top, gMin, floorH, facade.bay, part(facade.material), r);
      }
    }
    // roof covering: aerial photo when there is imagery; else the material from the data, or the
    // style's usual one on pitched roofs (gravel on flat ones)
    const cover = photoRoof ? null : kit.roof(roofKind || (roof.rise > 0 ? STYLES[style].roofKind : 'flat'), roofColour);
    addRoofFaces(roof, top, size, part(photoRoof || cover.material), photoRoof ? 'photo' : cover.metres);
    footprints.push(outer);
    kept++;
  }
  for (const [mat, p] of parts) {
    if (!p.pos.length) continue;
    const m = new THREE.Mesh(geom(p.pos, p.uv), mat);
    m.name = mat === groundMat || /^roof/.test(mat.name) ? 'roofs' : 'walls';
    // the facade photos are generic tiles: a plain wall in the tile's colour can stand in for them
    if (m.name === 'walls') alternates.set(m, plainVersion(mat));
    group.add(m);
  }

  // ---- trees
  let treeCount = 0, exportTrees = [];
  facts.trees = { mapped: 0, generated: 0 };
  if (nature) {
    const inBuilding = polygonIndex(footprints.map((r) => ({ outer: r, holes: [] })));
    const onCarriageway = carriagewayIndex([...localRoads, ...localRails]);
    const areas = [];
    for (const v of nature.vegetation || []) {
      const how = plantingFor(v.kind || '');
      if (!how) continue;
      const p = toLocalPoly(v);
      if (p.outer.length >= 3) areas.push({ ...p, ...how });
    }
    const trees = plantTrees({
      points: (nature.trees || []).map(([lat, lon, h]) => [...proj.toLocal(lat, lon), h]),
      rows: (nature.rows || []).map((r) => r.map(([lat, lon]) => proj.toLocal(lat, lon))),
      areas,
      ground,
      radius,
      blocked: (x, y) => inBuilding(x, y) || !!waterAt(x, y) || onCarriageway(x, y),
      seed: Math.round(proj.lat0 * 1e4 + proj.lon0 * 1e4),
    });
    treeCount = trees.count;
    exportTrees = trees.spots;
    facts.trees = { mapped: trees.mapped.count, generated: trees.generated.count };
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.95 });
    trunkMat.name = 'tree-trunk';
    const leaves = ['#4f7a3a', '#3f6b34', '#6a8f45'].map((col, i) => Object.assign(new THREE.MeshStandardMaterial({ color: col, roughness: 0.9 }), { name: `tree-leaves-${i}` }));
    // 'trees': real positions (mapped trees, tree rows); 'trees-generated': planted in woods and parks
    for (const [set, name] of [[trees.mapped, 'trees'], [trees.generated, 'trees-generated']]) {
      if (set.trunk.length) { const m = new THREE.Mesh(geom(set.trunk), trunkMat); m.name = name; group.add(m); }
      set.crowns.forEach((c, i) => { if (c.length) { const m = new THREE.Mesh(geom(c), leaves[i]); m.name = name; group.add(m); } });
    }
  }

  // ---- roads and sidewalks, following the terrain mesh
  // a road whose line clips the river's outline (low quays, roads along the bank: the outline is a
  // few metres off) stays on the land next to it, not on the carved river bed: the height of the
  // nearest land, at least 0.6 m above the water
  const waterFloor = (e, n) => {
    const w = waterAt(e, n);
    if (!w) return -Infinity;
    for (const r of [2, 4, 6, 9, 12]) {
      let best = Infinity;
      for (let k = 0; k < 8; k++) {
        const x = e + r * Math.cos((k * Math.PI) / 4), y = n + r * Math.sin((k * Math.PI) / 4);
        if (!waterAt(x, y)) best = Math.min(best, terrainAt(x, y));
      }
      if (best < Infinity) return Math.max(w.level + 0.6, best);
    }
    return w.level + 0.6;
  };
  let roadCount = 0;
  if (roads?.length) {
    const local = localRoads;
    const roadKit = createRoadKit();
    const built = buildRoads(local, { terrainAt, size, kit: roadKit, waterFloor });
    roadCount = built.count;
    // shares over the downloaded roads, applied to the ones built inside the area
    const share = (f) => Math.round((built.count * roads.filter(f).length) / Math.max(1, roads.length));
    facts.roads = { count: built.count, measuredWidths: share((r) => r.measuredWidth), sidewalks: share((r) => !r.tunnel && (r.sides?.left || r.sides?.right)) };
    for (const [mat, p] of built.parts) {
      if (!p.pos.length) continue;
      const m = new THREE.Mesh(geom(p.pos, p.uv), mat);
      m.name = mat.name === 'sidewalk' ? 'sidewalks' : 'roads';
      if (mat === roadKit.roadLine) alternates.set(m, roadKit.road); // the dashed centre line is drawn, not mapped
      group.add(m);
    }
  }

  // ---- railways (OSM): ballast and rails on the terrain, trams on the street
  if (localRails.length) {
    const built = buildRoads(localRails, { terrainAt, size, kit: createRoadKit(), waterFloor });
    facts.rails = built.count;
    for (const [mat, p] of built.parts) {
      if (!p.pos.length) continue;
      const m = new THREE.Mesh(geom(p.pos, p.uv), mat);
      m.name = 'railways';
      group.add(m);
    }
  }

  // roads and railways are laid: the terrain goes down a little under them (no triangle pokes through)
  terrain.sink(onRoad, 0.3);

  // ---- water (separate mesh; the world animates it)
  if (waters.length) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2d6680, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.88 });
    mat.name = 'water';
    const m = new THREE.Mesh(geom(waterMesh(waters)), mat);
    m.name = 'water';
    group.add(m);
  }

  return {
    group,
    count: kept,
    pitched,
    roadCount,
    treeCount,
    facts: { ...facts, water: waters.length, facades: facades ? 'photo library' : 'drawn' },
    // for the GeoJSON export: buildings (lat/lon outlines + what was built), trees and water (local)
    exportData: { buildings: exportBuildings, trees: exportTrees, water: waters.map((w) => ({ outer: w.outer, holes: w.holes, level: w.level })) },
    spawn: findSpawn(footprints, ground, radius, (e, n) => !!waterAt(e, n)),
    // model frame (x = east, z = -north) for the world's animated water
    water: waters.map((w) => ({ level: w.level, outer: w.outer.map(([e, n]) => [e, -n]), holes: w.holes.map((h) => h.map(([e, n]) => [e, -n])) })),
  };
}

// Nearest open spot to the picked point: outside every footprint and water, clear of walls.
// Prefers 6 m of clearance (room for a third-person camera), then 4 m, then 2 m.
// Returned in model coordinates (Y-up, -Z north), 1 m above the ground.
function findSpawn(footprints, ground, radius, blocked) {
  for (const clear of [6, 4, 2]) {
    const s = searchSpawn(footprints, ground, radius * 0.6, clear, blocked);
    if (s) return s;
  }
  return { x: 0, y: ground(0, 0) + 1, z: 0 };
}

function searchSpawn(footprints, ground, maxDist, CLEAR, blocked) {
  const boxes = footprints.map(bbox);
  const isFree = (e, n) => {
    if (blocked(e, n)) return false;
    for (let i = 0; i < footprints.length; i++) {
      const [x0, y0, x1, y1] = boxes[i];
      if (e < x0 - CLEAR || e > x1 + CLEAR || n < y0 - CLEAR || n > y1 + CLEAR) continue;
      const r = footprints[i];
      if (pointInRingLocal(e, n, r) || distToRing(e, n, r) < CLEAR) return false;
    }
    return true;
  };
  for (let d = 0; d <= maxDist; d += 2) {
    const steps = Math.max(1, Math.round((2 * Math.PI * d) / 2));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * 2 * Math.PI;
      const e = d * Math.cos(a), n = d * Math.sin(a);
      if (isFree(e, n)) return { x: e, y: ground(e, n) + 1, z: -n };
    }
  }
  return null;
}

function pointInRingLocal(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x, y, r) {
  let best = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

// ---------- helpers ----------

/** Mesh → stand-in material for generated details (plain walls, unmarked roads); kept out of userData so it never lands in the GLB. */
export const alternates = new WeakMap();

/** A plain wall material in the colour of a facade material (its tile's average, or its tint). */
const plainCache = new Map();
function plainVersion(mat) {
  if (plainCache.has(mat)) return plainCache.get(mat);
  const colour = new THREE.Color(mat.userData.mean || '#d9d2c4');
  if (mat.color) colour.multiply(mat.color);
  const m = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9 });
  m.name = `plain-${mat.name}`;
  plainCache.set(mat, m);
  return m;
}

/** Indexes of buildings whose outline comes within ~0.8 m of another's (shared walls, row houses). */
function touchingBuildings(buildings) {
  if (!buildings.length) return new Set();
  const lat0 = buildings[0].outer[0][0], kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
  const G = 40, pad = 0.8, rings = [], boxes = [], grid = new Map(), out = new Set();
  buildings.forEach((b, i) => {
    const r = b.outer.map(([la, lo]) => [lo * kx, la * ky]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    rings.push(r); boxes.push([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
    for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) {
      const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  const segDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const near = (A, B) => A.some((p) => B.some((q, k) => segDist(p, q, B[(k + 1) % B.length]) < pad));
  const seen = new Set();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) {
      const i = list[a], j = list[c], key = i * 1e6 + j;
      if (seen.has(key)) continue;
      seen.add(key);
      if ((buildings[i].minHeight || 0) !== (buildings[j].minHeight || 0)) continue; // stacked parts of one tower
      const A = boxes[i], B = boxes[j];
      if (A[0] > B[2] || B[0] > A[2] || A[1] > B[3] || B[1] > A[3]) continue;
      if (near(rings[i], rings[j]) || near(rings[j], rings[i])) { out.add(i); out.add(j); }
    }
  }
  return out;
}

// `seam` on a point (vector tiles): the edge starting there is a tile cut, not a real wall.
function ringToLocal(ring, proj) {
  const pts = ring.map((p) => { const q = proj.toLocal(p[0], p[1]); if (p.seam) q.seam = true; return q; });
  const a = pts[0], b = pts[pts.length - 1];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop(); // drop closing duplicate
  return pts;
}

function signedArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function centroid(r) {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

const v3 = (e, h, n) => [e, h, -n];

/**
 * Walls of one ring from y0 up to y1 (+ the roof height along the wall when `roof` is pitched,
 * so gable ends become triangles). Texture: u = metres along the facade / bay width,
 * v = (height - vBase) / tile height, so tiles start at vBase (ground or top of the shop band).
 * Ring must be CCW for outer / CW for holes, so (a,b,c) faces outward.
 */
/** Reverse a ring in place, keeping the `seam` flag on the first point of each flagged edge. */
function reverseRing(ring) {
  const n = ring.length, seams = ring.map((p) => !!p.seam);
  ring.reverse();
  // reversed edge j (ring[j] → ring[j+1]) is original edge n-2-j (the closing edge for j = n-1)
  for (let j = 0; j < n; j++) { const s = seams[(n - 2 - j + n) % n]; if (s) ring[j].seam = true; else delete ring[j].seam; }
  return ring;
}

function addWalls(ring, y0, y1, vBase, tileH, bay, out, roof = null) {
  let u = 0;
  const v = (y) => (y - vBase) / tileH;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-3) continue;
    if (p.seam) { u += Math.max(1, Math.round(len / bay)); continue; } // a tile cut inside the building: no wall
    // whole bays per segment: stretch slightly so a window never gets cut at a corner
    const bays = Math.max(1, Math.round(len / bay));
    const tops = roof && roof.rise > 0 ? roof.wallTop(p, q) : [[0, 0], [1, 0]];
    for (let k = 0; k < tops.length - 1; k++) {
      const [t0, h0] = tops[k], [t1, h1] = tops[k + 1];
      const P0 = [p[0] + t0 * (q[0] - p[0]), p[1] + t0 * (q[1] - p[1])], P1 = [p[0] + t1 * (q[0] - p[0]), p[1] + t1 * (q[1] - p[1])];
      const a = v3(P0[0], y0, P0[1]), b = v3(P1[0], y0, P1[1]);
      const c = v3(P1[0], y1 + h1, P1[1]), d = v3(P0[0], y1 + h0, P0[1]);
      const ua = u + t0 * bays, ub = u + t1 * bays;
      out.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      out.uv.push(ua, v(y0), ub, v(y0), ub, v(y1 + h1), ua, v(y0), ub, v(y1 + h1), ua, v(y1 + h0));
    }
    u += bays;
  }
}

/** Roof surfaces: flat (with courtyards) or one planar polygon per pitched face. */
/**
 * Roof faces. uv: 'photo' (the orthophoto seen from above, same UVs as the terrain), a number of
 * metres per texture repeat (v runs down the slope, so tile rows and zinc seams follow the eaves),
 * or 0 (plain colour).
 */
function addRoofFaces(roof, top, size, out, uv) {
  for (const f of roof.faces) {
    if (!f.fn) { addRoof(f.poly, f.holes || [], top, size, out, uv); continue; }
    const contour = f.poly.map(([e, n]) => new THREE.Vector2(e, n));
    const g = Math.hypot(f.fn.a, f.fn.b), dx = g ? f.fn.a / g : 0, dy = g ? f.fn.b / g : 1;
    const stretch = Math.sqrt(1 + g * g); // slope length per metre on the map
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      let a = contour[i], b = contour[j], c = contour[k];
      if ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) < 0) [b, c] = [c, b]; // face up
      for (const p of [a, b, c]) {
        out.pos.push(...v3(p.x, top + f.fn.a * p.x + f.fn.b * p.y + f.fn.c, p.y));
        if (uv === 'photo') out.uv.push((p.x + size) / (2 * size), (p.y + size) / (2 * size));
        else if (uv) out.uv.push((p.x * dy - p.y * dx) / uv, ((p.x * dx + p.y * dy) * stretch) / uv);
        else out.uv.push(0, 0);
      }
    }
  }
}

function addRoof(outer, holes, top, size, out, uv) {
  const contour = outer.map(([e, n]) => new THREE.Vector2(e, n));
  const hs = holes.map((h) => h.map(([e, n]) => new THREE.Vector2(e, n)));
  const all = [...contour, ...hs.flat()];
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, hs)) {
    let a = all[i], b = all[j], c = all[k];
    // In (east, north) a CCW triangle maps to an upward-facing one in Y-up/-Z-north.
    if ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) < 0) [b, c] = [c, b];
    out.pos.push(...v3(a.x, top, a.y), ...v3(b.x, top, b.y), ...v3(c.x, top, c.y));
    // Photo roofs: same UV space as the terrain (the orthophoto seen straight down).
    for (const p of [a, b, c]) {
      if (uv === 'photo') out.uv.push((p.x + size) / (2 * size), (p.y + size) / (2 * size));
      else if (uv) out.uv.push(p.x / uv, p.y / uv);
      else out.uv.push(0, 0);
    }
  }
}

/**
 * Terrain grid. With banks ({ waterAt, low(w, e, n), top(e, n, dx, dy) }), cells crossed by a water
 * edge are cut marching-squares style: the exact crossing points on the cell's sides (bisection)
 * split it into a land part at ground height and a water part at bed height, joined by a vertical
 * wall (returned as `walls`, its own material). The bank is straight inside each cell, so it follows
 * the real edge without the sawtooth a plain height grid gives.
 */
function buildTerrain(ground, size, res, material, banks = null, wallMaterial = null, keepGround = () => false, onRoad = () => false) {
  const pos = [], idx = [], uv = [];
  const w = res + 1, step = (2 * size) / res;
  const water = []; // per grid vertex: the water body it is in (or null)
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const e = -size + step * i, n = size - step * j;
      pos.push(...v3(e, ground(e, n), n));
      uv.push((e + size) / (2 * size), (n + size) / (2 * size));
      if (banks) water.push(banks.waterAt(e, n));
    }
  }
  const E = (v) => pos[v * 3], N = (v) => -pos[v * 3 + 2];
  const addVertex = (e, h, n) => { pos.push(...v3(e, h, n)); uv.push((e + size) / (2 * size), (n + size) / (2 * size)); return pos.length / 3 - 1; };
  const wall = { pos: [], uv: [] };
  const mixed = new Set();

  // Crossing on the grid side between vertex p (land) and q (water), shared by the two cells of
  // that side: the point, a "top" vertex (land height) and a "low" one (bed height).
  const crossings = new Map();
  const crossing = (p, q) => {
    const k = p < q ? `${p}-${q}` : `${q}-${p}`;
    if (crossings.has(k)) return crossings.get(k);
    const pe = E(p), pn = N(p), qe = E(q), qn = N(q);
    let lo = 0, hi = 1; // t from p (land) to q (water)
    for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (banks.waterAt(pe + (qe - pe) * m, pn + (qn - pn) * m)) hi = m; else lo = m; }
    const t = (lo + hi) / 2, e = pe + (qe - pe) * t, n = pn + (qn - pn) * t;
    const dl = Math.hypot(pe - qe, pn - qn) || 1;
    let hTop = banks.top(e, n, (pe - qe) / dl, (pn - qn) / dl);
    if (shelf[p]) hTop = Math.max(hTop, pos[p * 3 + 1]); // the land corner went onto a quay shelf: the wall rises to it
    const hLow = Math.min(hTop - 0.5, banks.low(water[q], e, n));
    const c = { e, n, hTop, hLow, top: addVertex(e, hTop, n), low: addVertex(e, hLow, n) };
    crossings.set(k, c);
    return c;
  };
  const lowerCorner = (v) => { pos[v * 3 + 1] = Math.min(pos[v * 3 + 1], banks.low(water[v], E(v), N(v))); };
  // fan over a border ring listed clockwise from above → counter-clockwise triangles (facing up)
  const fan = (vs) => { for (let k = 1; k < vs.length - 1; k++) idx.push(vs[0], vs[k + 1], vs[k]); };
  // vertical wall between two crossings, facing away from the land point (le, ln)
  const wallQuad = (c1, c2, le, ln) => {
    const q = [[c1.e, c1.hTop, c1.n], [c2.e, c2.hTop, c2.n], [c2.e, c2.hLow, c2.n], [c1.e, c1.hLow, c1.n]];
    const sx = c2.e - c1.e, sy = c2.n - c1.n, len = Math.hypot(sx, sy);
    const toLand = (le - c1.e) * sy - (ln - c1.n) * sx; // side of the land relative to c1 → c2
    const order = toLand > 0 ? [0, 1, 2, 0, 2, 3] : [0, 3, 2, 0, 2, 1];
    const uvs = [[0, c1.hTop / 3], [len / 3, c2.hTop / 3], [len / 3, c2.hLow / 3], [0, c1.hLow / 3]];
    for (const k of order) { const [e, h, n] = q[k]; wall.pos.push(...v3(e, h, n)); wall.uv.push(...uvs[k]); }
  };

  // ---- Quay and retaining walls on land. The 1 m elevation model smooths a 5 m quay wall into a
  // slope 8-10 m wide, which the photo turns into grey rock. Where the ground has two flat levels at
  // least WALL_GAP apart within ~12 m (a quay: the lower quay and the street; a natural hillside has
  // no such shelves), the slope is pressed onto the two levels and cut along its middle height with a
  // vertical stone wall, like the water's edge. Next to the water the bank cut above does the job.
  const WALL_GAP = 3, SHELF = 0.8, R = Math.max(2, Math.round(12 / step));
  const H0 = Float32Array.from({ length: w * w }, (_, v) => pos[v * 3 + 1]); // heights before snapping
  const dry = (v) => !banks || !water[v];
  const nearWater = (v) => {
    if (!banks) return false;
    const i = v % w, j = (v - i) / w;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii <= res && jj <= res && water[jj * w + ii]) return true;
    }
    return false;
  };
  const shelf = new Array(w * w).fill(null); // per vertex: { up, mid, lo, hi } where it sits on a quay
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const v = j * w + i;
      if (!dry(v) || keepGround(E(v), N(v))) continue;
      const hs = [];
      for (let jj = Math.max(0, j - R); jj <= Math.min(res, j + R); jj++) for (let ii = Math.max(0, i - R); ii <= Math.min(res, i + R); ii++) if (dry(jj * w + ii)) hs.push(H0[jj * w + ii]);
      if (hs.length < 12) continue;
      let lo = Infinity, hi = -Infinity;
      for (const h of hs) { if (h < lo) lo = h; if (h > hi) hi = h; }
      if (hi - lo < WALL_GAP) continue;
      let nLo = 0, nHi = 0;
      for (const h of hs) { if (h < lo + SHELF) nLo++; else if (h > hi - SHELF) nHi++; }
      const need = Math.max(4, hs.length * 0.06); // a narrow lower quay is only a few vertices wide
      if (nLo < need || nHi < need) continue; // no flat shelves: a hillside
      const mid = (lo + hi) / 2;
      // by the water: snapped too (the bank wall then rises to the shelf), but no wall cut of its own
      shelf[v] = { up: H0[v] > mid, mid, lo, hi, edge: nearWater(v) };
    }
  }
  // the slope's vertices go onto their shelf
  for (let v = 0; v < w * w; v++) {
    const q = shelf[v];
    if (!q || H0[v] <= q.lo + SHELF || H0[v] >= q.hi - SHELF || onRoad(E(v), N(v))) continue; // roads keep their ground
    pos[v * 3 + 1] = q.up ? q.hi : q.lo;
  }
  // beside ramps (kept off the shelves) the elevation model's lumps become an even slope: a few
  // smoothing passes, the ramp itself and everything else staying put
  const besideRamp = [];
  for (let v = 0; v < w * w; v++) if (dry(v) && keepGround(E(v), N(v)) && !onRoad(E(v), N(v))) besideRamp.push(v);
  for (let it = 0; it < 4; it++) {
    const next = besideRamp.map((v) => {
      const i = v % w, j = (v - i) / w;
      let sum = 0, cnt = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii > res || jj > res || !dry(jj * w + ii)) continue;
        sum += pos[(jj * w + ii) * 3 + 1]; cnt++;
      }
      return cnt ? (pos[v * 3 + 1] + sum) / (cnt + 1) : pos[v * 3 + 1];
    });
    besideRamp.forEach((v, k) => { pos[v * 3 + 1] = next[k]; });
  }
  // a wall between an upper and a lower vertex, unless a road covers that whole grid side (it would
  // stand on the road; the same answer for both cells sharing the side)
  const offRoad = new Map();
  const hasRoom = (p, q) => {
    const k = p < q ? p * w * w + q : q * w * w + p;
    if (!offRoad.has(k)) {
      let room = false;
      for (let t = 0.05; t <= 0.951 && !room; t += 0.05) room = !onRoad(E(p) + (E(q) - E(p)) * t, N(p) + (N(q) - N(p)) * t);
      offRoad.set(k, room);
    }
    return offRoad.get(k);
  };
  const isWall = (p, q) => shelf[p] && shelf[q] && !shelf[p].edge && !shelf[q].edge && shelf[p].up !== shelf[q].up && hasRoom(p, q);
  // the wall's foot on a grid side between an upper vertex p and a lower one q: where the original
  // ground crosses the middle height
  const wallCrossing = (p, q) => {
    const k = p < q ? `w${p}-${q}` : `w${q}-${p}`;
    if (crossings.has(k)) return crossings.get(k);
    const mid = (shelf[p].mid + shelf[q].mid) / 2;
    let t = Math.min(0.8, Math.max(0.2, (H0[p] - mid) / ((H0[p] - H0[q]) || 1)));
    // a wall never stands on a road: moved to the road's edge (the nearest point off it)
    const at = (tt) => [E(p) + (E(q) - E(p)) * tt, N(p) + (N(q) - N(p)) * tt];
    if (onRoad(...at(t))) {
      let best = null;
      for (let tt = 0.05; tt <= 0.951; tt += 0.05) if (!onRoad(...at(tt)) && (best == null || Math.abs(tt - t) < Math.abs(best - t))) best = tt;
      if (best != null) t = best;
    }
    const [e, n] = at(t);
    const hTop = pos[p * 3 + 1], hLow = Math.min(hTop - 0.5, pos[q * 3 + 1]);
    const c = { e, n, hTop, hLow, top: addVertex(e, hTop, n), low: addVertex(e, hLow, n) };
    crossings.set(k, c);
    return c;
  };
  const wallCells = new Map(); // cell → { mid } for heightAt
  const cellTris = new Map();  // cut cell → [first, end) of its triangles in idx (exact heights)
  // a land cell crossed by a quay wall: the border with the wall crossings inserted, cut into runs
  // (crossing, corners, crossing); each run is fanned at its own level, upper runs get the wall
  const cutWall = (ring) => {
    const cross = ring.map((p, k) => isWall(p, ring[(k + 1) % 4]));
    if (!cross.some(Boolean)) return false;
    const border = [];
    for (let k = 0; k < 4; k++) {
      const p = ring[k], q = ring[(k + 1) % 4];
      border.push({ v: p });
      if (cross[k]) border.push({ x: shelf[p].up ? wallCrossing(p, q) : wallCrossing(q, p) });
    }
    const s0 = border.findIndex((x) => x.x);
    const seq = [...border.slice(s0), ...border.slice(0, s0)];
    const runs = [];
    for (let k = 0; k < seq.length; k++) {
      if (!seq[k].x) continue;
      const run = { from: seq[k].x, corners: [], to: null };
      for (let m = k + 1; m <= seq.length; m++) {
        const x = seq[m % seq.length];
        if (x.x) { run.to = x.x; break; }
        run.corners.push(x.v);
      }
      runs.push(run);
    }
    const up = (v) => !!shelf[v]?.up || (!shelf[v] && pos[v * 3 + 1] > (runs[0].from.hTop + runs[0].from.hLow) / 2);
    for (const r of runs) {
      const u0 = up(r.corners[0]), u1 = up(r.corners[r.corners.length - 1]);
      fan([u0 ? r.from.top : r.from.low, ...r.corners, u1 ? r.to.top : r.to.low]);
      if (u0 && u1 && r.from !== r.to) wallQuad(r.from, r.to, E(r.corners[0]), N(r.corners[0]));
    }
    if (runs.length === 4) fan(runs.map((r) => r.from.low));
    const m = ring.map((v) => shelf[v]?.mid).filter((x) => x != null);
    const upCorner = ring.find((v) => shelf[v]?.up);
    const xs = runs.map((r) => r.from);
    wallCells.set(ring[0], {
      mid: m.reduce((x, y) => x + y, 0) / m.length,
      // two crossings (the usual case): the wall is the segment between them
      seg: xs.length === 2 && upCorner != null ? [xs[0], xs[1], E(upCorner), N(upCorner)] : null,
      ring,
    });
    return true;
  };

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1; // a=NW b=NE c=SW d=SE
      const ring = [a, b, d, c];                              // clockwise seen from above
      const wet = banks ? ring.map((v) => !!water[v]) : null;
      const t0 = idx.length;
      if (!banks || wet.every((x) => x === wet[0])) {
        if (!wet?.[0] && cutWall(ring)) { cellTris.set(a, [t0, idx.length]); continue; }
        idx.push(a, c, b, b, c, d);
        continue;
      }
      mixed.add(a);
      // the border with the crossings inserted, then cut into runs: crossing, corners of one kind, crossing
      const border = [];
      for (let k = 0; k < 4; k++) {
        const p = ring[k], q = ring[(k + 1) % 4];
        border.push({ v: p, wet: wet[k] });
        if (wet[k] !== wet[(k + 1) % 4]) border.push({ x: wet[k] ? crossing(q, p) : crossing(p, q) });
      }
      const s0 = border.findIndex((s) => s.x);
      const seq = [...border.slice(s0), ...border.slice(0, s0)];
      const runs = [];
      for (let k = 0; k < seq.length; k++) {
        if (!seq[k].x) continue;
        const run = { from: seq[k].x, corners: [], to: null };
        for (let m = k + 1; m <= seq.length; m++) {
          const s = seq[m % seq.length];
          if (s.x) { run.to = s.x; break; }
          run.corners.push(s);
        }
        runs.push(run);
      }
      for (const r of runs) {
        const isWet = r.corners[0].wet;
        if (isWet) r.corners.forEach((s) => lowerCorner(s.v));
        fan([isWet ? r.from.low : r.from.top, ...r.corners.map((s) => s.v), isWet ? r.to.low : r.to.top]);
        if (!isWet) { const land = r.corners[0].v; wallQuad(r.from, r.to, E(land), N(land)); }
      }
      if (runs.length === 4) fan(runs.map((r) => r.from.low)); // saddle: the middle of the cell is water
      cellTris.set(a, [t0, idx.length]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = 'terrain';
  let walls = null;
  if (wall.pos.length) {
    walls = new THREE.Mesh(geom(wall.pos, wall.uv), wallMaterial);
    walls.name = 'quays';
  }
  // Height at any point, interpolated on the same triangles as the mesh (diagonal NE–SW); in a cell
  // cut by a bank, a land point takes the ground itself (the cut surface follows it closely).
  const heightAt = (e, n) => {
    const fi = Math.min(res - 1e-6, Math.max(0, ((e + size) / (2 * size)) * res));
    const fj = Math.min(res - 1e-6, Math.max(0, ((size - n) / (2 * size)) * res));
    const i = Math.floor(fi), j = Math.floor(fj), fx = fi - i, fy = fj - j;
    const tris = cellTris.get(j * w + i);
    if (tris) { // a cell cut by a bank or a wall: the height of the triangle the point is in
      for (let k = tris[0]; k < tris[1]; k += 3) {
        const A = idx[k], B = idx[k + 1], C = idx[k + 2];
        const ax = E(A), ay = N(A), bx = E(B), by = N(B), cx = E(C), cy = N(C);
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const l1 = ((by - cy) * (e - cx) + (cx - bx) * (n - cy)) / den, l2 = ((cy - ay) * (e - cx) + (ax - cx) * (n - cy)) / den, l3 = 1 - l1 - l2;
        if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4) return l1 * pos[A * 3 + 1] + l2 * pos[B * 3 + 1] + l3 * pos[C * 3 + 1];
      }
    }
    if (mixed.has(j * w + i) && !banks.waterAt(e, n)) return ground(e, n);
    const H = (ii, jj) => pos[(jj * w + ii) * 3 + 1];
    const wc = wallCells.get(j * w + i);
    if (wc) { // in a cell cut by a quay wall: the level of the side of the wall this point is on
      let upper;
      if (wc.seg) {
        const [c1, c2, ue, un] = wc.seg;
        const side = (pe, pn) => Math.sign((c2.e - c1.e) * (pn - c1.n) - (c2.n - c1.n) * (pe - c1.e));
        upper = side(e, n) === side(ue, un);
      } else upper = ground(e, n) > wc.mid;
      const hs = wc.ring.filter((v) => !!shelf[v]?.up === upper).map((v) => pos[v * 3 + 1]);
      return hs.length ? hs.reduce((x, y) => x + y, 0) / hs.length : ground(e, n);
    }
    const A = H(i, j), B = H(i + 1, j), C = H(i, j + 1), D = H(i + 1, j + 1);
    return fx + fy <= 1 ? A + fx * (B - A) + fy * (C - A) : D + (1 - fx) * (C - D) + (1 - fy) * (B - D);
  };
  // Once roads are laid on the mesh: the grid points under them go down a little, so no terrain
  // triangle pokes through a road between the points it was sampled at.
  const sink = (under, depth) => {
    const a = g.attributes.position;
    let moved = 0;
    for (let v = 0; v < w * w; v++) if (under(E(v), N(v))) { a.setY(v, pos[v * 3 + 1] - depth); moved++; }
    if (moved) { a.needsUpdate = true; g.computeVertexNormals(); }
  };
  return { mesh: m, walls, heightAt, sink };
}

function geom(pos, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv || new Array((pos.length / 3) * 2).fill(0), 2));
  g.computeVertexNormals(); // non-indexed -> flat shading per face
  // Weld identical vertices into an indexed mesh (normals kept, so still flat-shaded). Smaller
  // GLB, and every mesh is indexed like the terrain: the world engine merges all meshes of the
  // place into one collision mesh, which fails when indexed and non-indexed geometries are mixed.
  return mergeVertices(g);
}
