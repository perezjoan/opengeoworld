// Exports with real coordinates, next to the GLB (which is in local metres around the picked point):
//
//  - GeoJSON (RFC 7946, WGS84 lon/lat): buildings with their heights and roofs, roads, railways,
//    trees, water and green areas, each with its source and how sure it is (measured / mapped /
//    estimated / generated). Opens in QGIS, ArcGIS, kepler.gl, geojson.io, MapLibre…
//  - 3D Tiles 1.1 (Cesium, QGIS 3D, ArcGIS, Unreal/Unity): the textured GLB plus a tileset.json that
//    places it on the globe, zipped together.
//
// Model frame: glTF Y-up, X east, -Z north, metres, origin = picked point at ground level; the
// ground altitude there (origin_alt_m, above the elevation model's own vertical datum) is in the
// metadata.

import { VERSION } from './version.js';

const GENERATOR = `OpenGeoWorld ${VERSION} (Urban Geo Analytics)`;
const r6 = (x) => Math.round(x * 1e6) / 1e6, r7 = (x) => Math.round(x * 1e7) / 1e7, r2 = (x) => Math.round(x * 100) / 100;
const lonLat = ([lat, lon]) => [r7(lon), r7(lat)];
const closeRing = (ring) => (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring);
// GeoJSON rings: exterior counter-clockwise, holes clockwise (RFC 7946 §3.1.6), in lon/lat
const signed = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]); return a / 2; };
const orient = (ring, ccw) => { const r = closeRing(ring); return (signed(r) > 0) === ccw ? r : [...r].reverse(); };
const polygon = (outer, holes = []) => ({ type: 'Polygon', coordinates: [orient(outer.map(lonLat), true), ...holes.filter((h) => h.length >= 3).map((h) => orient(h.map(lonLat), false))] });

/**
 * The place as a GeoJSON FeatureCollection. src: { meta, proj, h0, exportData, roads, rails,
 * vegetation, sources, show } — show(layer) says whether a layer is on (hidden layers stay out, as
 * in the GLB).
 */
export function placeToGeoJSON(src) {
  const { meta, proj, h0, exportData, roads, rails, vegetation, sources, show } = src;
  const alt = (z) => (h0 == null ? null : r2(h0 + z)); // model metres → altitude
  const toLL = ([e, n]) => proj.toLatLon(e, n);
  const features = [];
  const add = (geometry, properties) => features.push({ type: 'Feature', geometry, properties });

  // the area that was built (the terrain square)
  const s = meta.ground_extent_m;
  add(polygon([[-s, -s], [s, -s], [s, s], [-s, s]].map(toLL)), { layer: 'area', radius_m: meta.radius_m, origin_lat: meta.origin.lat, origin_lon: meta.origin.lon, origin_alt_m: meta.origin_alt_m });

  for (const b of exportData.buildings) {
    add(polygon(b.outer, b.holes), {
      layer: 'building',
      height_m: b.height, // eaves above the ground (the roof itself for flat roofs)
      min_height_m: b.minHeight || 0, // parts raised above the ground (setbacks, passages)
      roof_height_m: b.roofRise, roof_shape: b.roofShape,
      total_height_m: r2(b.minHeight + b.height + b.roofRise),
      ground_alt_m: alt(b.ground), top_alt_m: alt(b.ground + b.minHeight + b.height + b.roofRise),
      floors: b.floors, usage: b.usage, house: b.house, heritage: b.heritage,
      height_from: b.heightSource, roof_from: b.roofSource === 'flat' ? 'flat (no roof data)' : b.roofSource,
      outline_from: 'mapped', source: sources.buildings,
      facade_style: b.style, facade_from: 'generated',
    });
  }
  if (show('roads')) for (const r of roads || []) {
    if (r.line.length < 2) continue;
    const sides = r.sides?.left && r.sides?.right ? 'both' : r.sides?.left ? 'left' : r.sides?.right ? 'right' : 'none';
    add({ type: 'LineString', coordinates: r.line.map(lonLat) }, {
      layer: 'road', kind: r.kind, width_m: r.width, width_from: r.measuredWidth ? 'measured' : 'estimated',
      lanes: r.lanes || null, bridge: !!r.bridge, tunnel: !!r.tunnel,
      sidewalks: show('sidewalks') ? sides : 'none', sidewalks_from: 'generated', source: sources.roads,
    });
  }
  if (show('railways')) for (const r of rails || []) {
    if (r.line.length < 2) continue;
    add({ type: 'LineString', coordinates: r.line.map(lonLat) }, { layer: 'railway', kind: r.kind, bridge: !!r.bridge, tunnel: !!r.tunnel, source: sources.rails });
  }
  for (const t of exportData.trees) {
    if (!show(t.generated ? 'trees-generated' : 'trees')) continue;
    add({ type: 'Point', coordinates: lonLat(toLL([t.x, t.y])) }, {
      layer: 'tree', height_m: r2(t.h), kind: t.kind,
      position_from: t.generated ? 'generated' : 'mapped', source: t.generated ? 'planted at random in woods and parks' : sources.trees,
    });
  }
  if (show('water')) for (const w of exportData.water) {
    add(polygon(w.outer.map(toLL), w.holes.map((h) => h.map(toLL))), { layer: 'water', level_alt_m: alt(w.level), level_from: 'estimated', outline_from: 'mapped', source: sources.water });
  }
  if (show('trees')) for (const v of vegetation || []) {
    if (v.outer.length < 3) continue;
    add(polygon(v.outer, v.holes), { layer: 'vegetation', kind: v.kind || null, outline_from: 'mapped', source: sources.green });
  }
  return {
    type: 'FeatureCollection',
    // foreign members (RFC 7946 §6.1): where the place is and where everything comes from
    name: meta.name,
    opengeoworld: {
      origin: { lat: meta.origin.lat, lon: meta.origin.lon, alt_m: meta.origin_alt_m, altitude_datum: meta.altitude_datum },
      radius_m: meta.radius_m, generator: GENERATOR, attribution: meta.attribution, provenance: meta.provenance,
      note: 'height_m is above the ground; *_alt_m are altitudes above the elevation model\'s vertical datum. *_from: measured, mapped, estimated or generated (not in the data).',
    },
    features,
  };
}

// ---------- 3D Tiles ----------

/** WGS84 geodetic → Earth-centred, Earth-fixed (metres). h: height above the ellipsoid. */
function ecef(lat, lon, h) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - e2) + h) * Math.sin(p)];
}

/**
 * tileset.json for one GLB in the model frame. 3D Tiles turns glTF's Y-up into Z-up, so the model
 * arrives as east-north-up; the root transform puts that ENU frame at the origin on the globe.
 * height: ellipsoidal height of the model's origin (altitude + geoid undulation).
 * box: { half, minY, maxY } in model metres.
 */
export function tilesetJson({ lat, lon, height, box, glbName, extras }) {
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const o = ecef(lat, lon, height);
  const cz = (box.minY + box.maxY) / 2, hz = Math.max(1, (box.maxY - box.minY) / 2);
  return {
    asset: { version: '1.1', generator: GENERATOR },
    geometricError: Math.round(box.half * 2),
    root: {
      // column-major 4×4: ENU axes, then the origin in ECEF
      transform: [...east, 0, ...north, 0, ...up, 0, ...o.map(r6), 1],
      boundingVolume: { box: [0, 0, r2(cz), box.half, 0, 0, 0, box.half, 0, 0, 0, r2(hz)] },
      geometricError: 0,
      refine: 'ADD',
      content: { uri: glbName },
    },
    extras,
  };
}

// ---------- geoid ----------

/**
 * EGM96 geoid undulation (m) at a point: the gap between sea level, which the elevation models
 * measure from, and the WGS84 ellipsoid, which 3D Tiles places models on (Paris: +44.6 m, New York:
 * -32.7 m). From a 0.5° grid (assets/geoid/egm96-30min.i16: 361 rows from 90°N, 721 columns from
 * 180°W, int16 decimetres), bilinear: within 2 m of the full model. null when the grid is missing.
 */
const GEOID_STEP = 0.5, GEOID_NX = 721, GEOID_NY = 361;
let geoidGrid;
export async function geoidUndulation(lat, lon) {
  geoidGrid ??= fetch('assets/geoid/egm96-30min.i16').then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && new Int16Array(b)).catch(() => null);
  const g = await geoidGrid;
  if (!g || g.length !== GEOID_NX * GEOID_NY) return null;
  const x = Math.min(GEOID_NX - 1.0001, Math.max(0, (lon + 180) / GEOID_STEP)), y = Math.min(GEOID_NY - 1.0001, Math.max(0, (90 - lat) / GEOID_STEP));
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const at = (ii, jj) => g[jj * GEOID_NX + ii] / 10;
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}

// ---------- zip (stored, no compression: the GLB's textures are JPEG already) ----------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** files: [{ name, data: Uint8Array | ArrayBuffer | string }] → Blob (application/zip). */
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
