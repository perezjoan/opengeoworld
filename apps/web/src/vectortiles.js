// OpenStreetMap data from vector tiles (OpenFreeMap, OpenMapTiles schema): buildings with heights,
// roads, water, woods and parks for anywhere on Earth, from a CDN, with no key and none of the
// Overpass waits. Used outside France (IGN covers France).
//
// A small Mapbox Vector Tile decoder is included (protobuf varints, geometry commands), so there is
// no dependency. Features are cut at tile edges: every piece is clipped exactly at its tile's border
// and the edges lying on that border are flagged (`point.seam = true` on the edge's first point) so
// the mesher builds no wall there.

import { vectorTiles } from './basemap.js';

const Z = 14; // the schema's most detailed zoom: every building and road
let tileUrl = null;

// ---------------------------------------------------------------- protobuf / MVT
function reader(buf) {
  const b = new Uint8Array(buf);
  let pos = 0;
  const varint = () => {
    let v = 0, mul = 1, byte;
    do { byte = b[pos++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
    return v;
  };
  return {
    get pos() { return pos; },
    end: b.length,
    varint,
    skip(wire) {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += varint();
      else if (wire === 5) pos += 4;
      else throw new Error('vector tile: unknown wire type ' + wire);
    },
    bytes() { const n = varint(); const s = b.subarray(pos, pos + n); pos += n; return s; },
    fixed32f() { const v = new DataView(b.buffer, b.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return v; },
    fixed64f() { const v = new DataView(b.buffer, b.byteOffset + pos, 8).getFloat64(0, true); pos += 8; return v; },
  };
}
const utf8 = new TextDecoder();
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(bytes) {
  const r = reader(bytes);
  let v = null;
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) v = utf8.decode(r.bytes());
    else if (f === 2) v = r.fixed32f();
    else if (f === 3) v = r.fixed64f();
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = zigzag(r.varint());
    else if (f === 7) v = !!r.varint();
    else r.skip(w);
  }
  return v;
}

function packed(bytes) {
  const r = reader(bytes), out = [];
  while (r.pos < r.end) out.push(r.varint());
  return out;
}

/** Decode the layers we want: { name: { extent, features: [{ type, props, geom: [[x, y]…][] }] } }. */
function decodeTile(buf, wanted) {
  const layers = {};
  const r = reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    if (tag >> 3 !== 3) { r.skip(tag & 7); continue; }
    const lr = reader(r.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], raw = [];
    while (lr.pos < lr.end) {
      const t = lr.varint(), f = t >> 3;
      if (f === 1) name = utf8.decode(lr.bytes());
      else if (f === 2) raw.push(lr.bytes());
      else if (f === 3) keys.push(utf8.decode(lr.bytes()));
      else if (f === 4) values.push(readValue(lr.bytes()));
      else if (f === 5) extent = lr.varint();
      else lr.skip(t & 7);
    }
    if (!wanted.includes(name)) continue;
    const features = raw.map((fb) => {
      const fr = reader(fb);
      let type = 0, tags = [], geometry = [];
      while (fr.pos < fr.end) {
        const t = fr.varint(), f = t >> 3;
        if (f === 2) tags = packed(fr.bytes());
        else if (f === 3) type = fr.varint();
        else if (f === 4) geometry = packed(fr.bytes());
        else fr.skip(t & 7);
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      return { type, props, geom: decodeGeometry(geometry) };
    });
    layers[name] = { extent, features };
  }
  return layers;
}

function decodeGeometry(cmds) {
  const lines = [];
  let x = 0, y = 0, line = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
        if (id === 1) { line = []; lines.push(line); }
        line.push([x, y]);
      }
    } else if (id === 7) { /* ClosePath: rings are implicitly closed */ }
  }
  return lines;
}

const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; s += x1 * y2 - x2 * y1; } return s / 2; };

/** Polygons from MVT rings: positive area = outer ring, negative = hole of the last outer. */
function polygons(rings) {
  const out = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    const a = ringArea(r);
    if (a > 0) out.push({ outer: r, holes: [] });
    else if (a < 0 && out.length) out[out.length - 1].holes.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- clipping to the tile
/** Clip a ring to [0, E]²; edges lying on the border get `seam` on their first point. */
function clipRing(ring, E) {
  let out = ring.map((p) => [p[0], p[1]]);
  for (const [ax, v, keep] of [[0, 0, 1], [0, E, -1], [1, 0, 1], [1, E, -1]]) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const ina = (a[ax] - v) * keep >= 0, inb = (b[ax] - v) * keep >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const t = (v - a[ax]) / (b[ax] - a[ax]); const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; p[ax] = v; out.push(p); }
    }
  }
  const on = (p, q) => (p[0] === q[0] && (p[0] === 0 || p[0] === E)) || (p[1] === q[1] && (p[1] === 0 || p[1] === E));
  for (let i = 0; i < out.length; i++) if (on(out[i], out[(i + 1) % out.length])) out[i].seam = true;
  return out;
}

/** Clip a line to [0, E]² (Liang–Barsky per segment); returns pieces. */
function clipLine(line, E) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i < line.length - 1; i++) {
    let [x0, y0] = line[i], [x1, y1] = line[i + 1];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    let ok = true;
    for (const [p, q] of [[-dx, x0], [dx, E - x0], [-dy, y0], [dy, E - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { cur = null; continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy], b = [x0 + t1 * dx, y0 + t1 * dy];
    if (!cur || t0 > 0) { cur = [a]; pieces.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return pieces.filter((p) => p.length >= 2);
}

// ---------------------------------------------------------------- tiles → place data
const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;

// Countries driving on the left (rough boxes): one-way halves of a dual carriageway get their
// sidewalk on the outer side, which is the traffic's left there.
const LEFT_HAND = [[49.8, -10.7, 60.9, 1.8], [24, 122.9, 45.6, 146], [-44, 112, -10, 154], [-47.5, 166, -34, 179], [6, 68, 36, 92],
  [-35, 16, -22, 33], [-11, 95, 6, 141], [1, 99.5, 7.5, 119.5], [5.5, 97.3, 20.5, 105.7], [-21, 55, -19.9, 63.6]];
const leftHand = (lat, lon) => LEFT_HAND.some(([a, b, c, d]) => lat >= a && lat <= c && lon >= b && lon <= d);

const ROAD_WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7, minor: 6, service: 4, busway: 6, track: 3, path: 1.8, raceway: 0 };

async function tileBytes(z, x, y) {
  if (!tileUrl) { // OpenFreeMap, or CARTO (same schema) where the browser blocks OpenFreeMap
    const t = await vectorTiles();
    tileUrl = t.url;
    if (t.provider === 'carto') VECTOR_TILES_ATTRIBUTION = VECTOR_TILES_ATTRIBUTION.replace('OpenFreeMap vector tiles', 'CARTO vector tiles (OpenFreeMap blocked by the browser)');
  }
  const r = await fetch(tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: AbortSignal.timeout(30000) });
  if (r.status === 204 || r.status === 404) return null; // empty sea tile
  if (!r.ok) throw new Error(`vector tile ${z}/${x}/${y}: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return buf;
}

/**
 * Buildings, roads, water and vegetation around (lat, lon), in the shapes the other fetchers use:
 * { buildings: [{ outer, holes, height, minHeight, floors, roofShape, roofRise, tags }],
 *   roads: [{ line, width, lanes, kind, sides, bridge, tunnel }], rails: [{ line, kind: rail|tram, width, bridge }],
 *   water: [...], vegetation: [...] }
 * Rings and lines are [lat, lon] points.
 */
export async function fetchOSMVectorTiles(lat, lon, radius, log = () => {}) {
  const d = radius * 1.15 / 111320, dl = d / Math.cos((lat * Math.PI) / 180);
  const x0 = Math.floor(lon2x(lon - dl)), x1 = Math.floor(lon2x(lon + dl));
  const y0 = Math.floor(lat2y(lat + d)), y1 = Math.floor(lat2y(lat - d));
  log(`OpenStreetMap vector tiles: ${(x1 - x0 + 1) * (y1 - y0 + 1)} tile(s)…`);
  const left = leftHand(lat, lon);
  const out = { buildings: [], roads: [], rails: [], water: [], vegetation: [] };
  const heritage = []; // [lat, lon, kind]
  const outlines = []; // outlines of buildings drawn as parts (not built, used to find the parts of a church)
  const jobs = [];
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) jobs.push(tileBytes(Z, tx, ty).then((buf) => ({ tx, ty, buf })));
  for (const { tx, ty, buf } of await Promise.all(jobs)) {
    if (!buf) continue;
    const layers = decodeTile(buf, ['building', 'transportation', 'water', 'landcover', 'park', 'poi']);
    const toLL = (E) => (p) => {
      const q = [
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + p[1] / E)) / 2 ** Z))) * 180) / Math.PI,
        ((tx + p[0] / E) / 2 ** Z) * 360 - 180,
      ];
      if (p.seam) q.seam = true;
      return q;
    };
    // churches, castles, monuments (points): the building around one is heritage (the tiles carry no building type)
    for (const f of layers.poi?.features || []) {
      const c = f.props.class || '';
      if (f.type !== 1 || !/^(place_of_worship|castle|monument)$/.test(c)) continue;
      for (const g of f.geom) for (const pt of g) heritage.push([...toLL(layers.poi.extent)(pt), c === 'place_of_worship' ? 'church' : c]);
    }
    const polys = (layer, each) => {
      const L = layers[layer];
      if (!L) return;
      const ll = toLL(L.extent);
      for (const f of L.features) {
        if (f.type !== 3) continue;
        for (const p of polygons(f.geom)) {
          const outer = clipRing(p.outer, L.extent);
          if (outer.length < 3 || Math.abs(ringArea(outer)) < 1) continue;
          const holes = p.holes.map((h) => clipRing(h, L.extent)).filter((h) => h.length >= 3);
          each(f.props, outer.map(ll), holes.map((h) => h.map(ll)));
        }
      }
    };
    polys('building', (pr, outer, holes) => {
      if (pr.hide_3d) { outlines.push(outer); return; } // an outline whose parts (with their own heights) are in the tile too
      const min = Number(pr.render_min_height) || 0, h = Number(pr.render_height) || 6;
      if (h - min < 0.5) return;
      // the schema fills in 5 m when OSM has no height or levels: that one is an estimate
      out.buildings.push({ outer, holes, height: h - min, minHeight: min, floors: 0, roofShape: 'flat', roofRise: 0, heightIsTotal: true,
        heightSource: h === 5 && !min ? 'estimated' : 'mapped',
        tags: { building: 'yes', ...(pr.colour ? { 'building:colour': pr.colour } : {}) } });
    });
    polys('water', (pr, outer, holes) => { if (pr.class !== 'swimming_pool') out.water.push({ outer, holes, kind: 'water' }); });
    polys('landcover', (pr, outer, holes) => {
      const kind = pr.class === 'wood' ? 'wood' : pr.class === 'grass' ? 'grass' : pr.subclass === 'scrub' ? 'scrub' : null;
      if (kind) out.vegetation.push({ outer, holes, kind });
    });
    polys('park', (pr, outer, holes) => out.vegetation.push({ outer, holes, kind: 'park' }));
    const T = layers.transportation;
    if (T) {
      const ll = toLL(T.extent);
      for (const f of T.features) {
        if (f.type !== 2) continue;
        const pr = f.props, cls = pr.class || '';
        const sub = pr.subclass || '';
        // railways: trains, metro / light rail above ground, funiculars, trams (rails on the street)
        if (cls === 'rail' || cls === 'transit') {
          if (pr.brunnel === 'tunnel' || pr.indoor || /monorail|abandoned|disused|construction|platform|miniature/.test(sub)) continue;
          const kind = sub === 'tram' ? 'tram' : 'rail';
          for (const g of f.geom) for (const piece of clipLine(g, T.extent)) {
            out.rails.push({ line: piece.map(ll), kind, width: kind === 'tram' ? 1.8 : sub === 'narrow_gauge' || sub === 'funicular' ? 2.6 : 3.4,
              bridge: pr.brunnel === 'bridge', tunnel: false, service: !!pr.service });
          }
          continue;
        }
        if (!(cls in ROAD_WIDTH) || !ROAD_WIDTH[cls] || pr.indoor) continue;
        if (sub === 'steps' || sub === 'platform') continue;
        // pedestrian streets and squares, paved footways and cycleways: pavers; tracks and unpaved paths: gravel
        const pedestrian = sub === 'pedestrian';
        const unpaved = pr.surface === 'unpaved' || cls === 'track' || /bridleway/.test(sub) || (sub === 'path' && pr.surface !== 'paved');
        const kind = pedestrian ? 'pedestrian' : cls === 'path' || cls === 'track' ? (unpaved ? 'path' : 'footway') : 'road';
        const width = pedestrian ? 6 : cls === 'path' && /cycleway|footway/.test(sub) ? 2 : ROAD_WIDTH[cls];
        const street = /primary|secondary|tertiary|minor/.test(cls);
        const oneway = pr.oneway === 1 && /motorway|trunk|primary|secondary/.test(cls);
        const outer = left ? { left: true, right: false } : { left: false, right: true };
        const sides = !street ? { left: false, right: false } : oneway ? outer : { left: true, right: true };
        for (const g of f.geom) for (const piece of clipLine(g, T.extent)) {
          out.roads.push({ line: piece.map(ll), width, lanes: width >= 8 ? 2 : 1, kind, sides,
            bridge: pr.brunnel === 'bridge', tunnel: pr.brunnel === 'tunnel' });
        }
      }
    }
  }
  const has = (ring) => heritage.find(([la, lo]) => inRing(la, lo, ring));
  const marked = outlines.map((o) => [o, has(o)]).filter(([, h]) => h); // a church drawn as parts: all its parts
  for (const b of out.buildings) {
    let la = 0, lo = 0;
    for (const p of b.outer) { la += p[0]; lo += p[1]; }
    la /= b.outer.length; lo /= b.outer.length;
    const hit = has(b.outer) || marked.find(([o]) => inRing(la, lo, o))?.[1];
    if (hit) { b.tags.building = hit[2]; b.heritagePoint = hit; }
    b.c = [la, lo];
  }
  // parts of the same church that don't contain its point (towers, apses): touching a marked part and
  // within ~55 m of the point
  const box = (r) => { let s = 90, w = 180, n = -90, e = -180; for (const [la, lo] of r) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); } return [s - 2e-5, w - 2e-5, n + 2e-5, e + 2e-5]; };
  const near = out.buildings.filter((b) => heritage.some(([la, lo]) => Math.abs(b.c[0] - la) < 5e-4 && Math.abs(b.c[1] - lo) < 7e-4));
  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    const seeds = near.filter((b) => b.heritagePoint);
    for (const b of near) {
      if (b.heritagePoint) continue;
      const A = b.bx ??= box(b.outer);
      const hit = seeds.find((m) => { const B = m.bx ??= box(m.outer); return A[0] <= B[2] && B[0] <= A[2] && A[1] <= B[3] && B[1] <= A[3]; });
      if (hit) { b.heritagePoint = hit.heritagePoint; b.tags.building = hit.tags.building; grew = true; }
    }
    if (!grew) break;
  }
  for (const b of out.buildings) { delete b.c; delete b.bx; delete b.heritagePoint; }
  return out;
}

function inRing(lat, lon, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export let VECTOR_TILES_ATTRIBUTION = 'OpenStreetMap data from OpenFreeMap vector tiles (OpenMapTiles schema) – © OpenStreetMap contributors (ODbL)';
