// Data fetching: OSM buildings (Overpass) and elevation (AWS Terrain Tiles, Terrarium encoding).
import { inFrance } from './geo.js';
// Everything is converted to a local metric frame centred on the picked point:
// east (m), north (m). Good enough for areas of a few km.

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;

export function makeProjection(lat0, lon0) {
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    lat0, lon0,
    toLocal: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (e, n) => [lat0 + n / ky, lon0 + e / kx],
  };
}

// ---------- Buildings ----------

// Public Overpass servers are often overloaded: query several at once, keep the first good
// answer and cancel the others.
// Public Overpass servers (all with worldwide data). They are raced with a staggered start (a new one
// every OVERPASS_STAGGER ms while nobody has answered), and a second, longer round is tried before
// giving up: busy servers often answer on the second try.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const OVERPASS_STAGGER = 1200;
const OVERPASS_ROUNDS = 2;
const OVERPASS_TIMEOUT_MS = 90000;

export async function fetchBuildings(lat, lon, radius, log) {
  const q = `[out:json][timeout:90];
(
  way["building"](around:${radius},${lat},${lon});
  relation["building"]["type"="multipolygon"](around:${radius},${lat},${lon});
);
out geom;`;
  return parseBuildings(await overpass(q, log));
}

/**
 * Run an Overpass query: servers raced with a staggered start, first good answer wins; if none
 * answers within timeoutMs, a second round with 1.5× the time. Returns the elements (with .host).
 */
async function overpass(q, log, timeoutMs = OVERPASS_TIMEOUT_MS) {
  const why = [];
  for (let round = 1; round <= OVERPASS_ROUNDS; round++) {
    try {
      return await overpassRound(q, log, round === 1 ? timeoutMs : timeoutMs * 1.5, round);
    } catch (e) {
      why.push(e.message);
      if (round < OVERPASS_ROUNDS) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`No Overpass server answered (${OVERPASS.length} servers, ${OVERPASS_ROUNDS} rounds): ${why.join(' / ')}`);
}

async function overpassRound(q, log, timeoutMs, round) {
  const ctrl = OVERPASS.map(() => new AbortController());
  const timers = [setTimeout(() => ctrl.forEach((c) => c.abort()), timeoutMs)];
  let done = false;
  log(`Overpass: asking ${OVERPASS.length} servers${round > 1 ? ` (round ${round})` : ''}…`);
  try {
    const { elements, host } = await Promise.any(OVERPASS.map((url, i) => new Promise((resolve, reject) => {
      timers.push(setTimeout(async () => { // staggered start; skipped once someone answered
        if (done) return reject(new Error('not needed'));
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(q),
            signal: ctrl[i].signal,
          });
          if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
          const json = await res.json();
          if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`${new URL(url).host}: ${json.remark}`);
          done = true;
          ctrl.forEach((c, j) => j !== i && c.abort()); // winner: cancel the rest
          resolve({ elements: json.elements || [], host: new URL(url).host });
        } catch (e) { reject(e); }
      }, i * OVERPASS_STAGGER));
    })));
    log(`Overpass: answer from ${host}`);
    return Object.assign(elements, { host });
  } catch (e) {
    const list = e instanceof AggregateError ? e.errors.map((x) => x.name === 'AbortError' ? 'timeout' : x.message).filter((m) => m !== 'not needed') : [e.message];
    throw new Error(`round ${round}: ${[...new Set(list)].join('; ')}`);
  } finally {
    timers.forEach(clearTimeout);
  }
}

// IGN BD TOPO buildings (France only): measured heights, free, no key, fast.
// WFS 2.0 on the Géoplateforme, paged 5000 features at a time.
export async function fetchBuildingsIGN(lat, lon, radius, log) {
  const proj = makeProjection(lat, lon);
  const [latS, lonW] = proj.toLatLon(-radius, -radius);
  const [latN, lonE] = proj.toLatLon(radius, radius);
  const PAGE = 5000;
  const out = [];
  for (let start = 0; start < PAGE * 10; start += PAGE) {
    const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
      + '&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326'
      + `&BBOX=${latS},${lonW},${latN},${lonE},urn:ogc:def:crs:EPSG::4326&COUNT=${PAGE}&STARTINDEX=${start}`;
    log(`IGN BD TOPO: loading buildings${start ? ` (page ${start / PAGE + 1})` : ''}…`);
    const json = await fetchJson(url, { timeout: 60000 });
    for (const f of json.features || []) {
      const p = f.properties || {};
      const h = p.hauteur > 0 ? p.hauteur : p.nombre_d_etages > 0 ? p.nombre_d_etages * 3 + 1 : 7;
      const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const [outer, ...holes] = poly.map((ring) => closeRing(ring.map(([x, y]) => [y, x])));
        // hauteur = eaves height; roof rise = highest - lowest roof point (> 15 m = data error)
        const rise = p.altitude_maximale_toit - p.altitude_minimale_toit;
        if (outer.length >= 4) out.push({
          outer, holes: holes.filter((r) => r.length >= 4), height: h, floors: p.nombre_d_etages > 0 ? p.nombre_d_etages : 0,
          heightSource: p.hauteur > 0 ? 'measured' : p.nombre_d_etages > 0 ? 'mapped' : 'estimated',
          roofShape: 'auto', roofRise: Number.isFinite(rise) && rise > 0 && rise < 15 ? rise : 0,
          tags: { usage: `${p.usage_1 || ''} ${p.usage_2 || ''}`.trim(), nature: p.nature, wallMat: p.materiaux_des_murs || '', roofMat: p.materiaux_de_la_toiture || '' },
        });
      }
    }
    if ((json.features || []).length < PAGE) break;
  }
  return out;
}

/**
 * GET JSON with retries: public services occasionally answer with an error page or, for IGN,
 * an unrelated monitoring page with a 200 status, which the browser then caches. Retries bypass
 * (and overwrite) the HTTP cache so one bad answer doesn't stick.
 */
async function fetchJson(url, { timeout = 45000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: attempt ? 'reload' : 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (e.name === 'TimeoutError' || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function closeRing(r) {
  const a = r[0], b = r[r.length - 1];
  return a && b && (a[0] !== b[0] || a[1] !== b[1]) ? [...r, a] : r;
}

// ---------- Nature: water and vegetation ----------
// Polygons come back as { outer: [[lat,lon]…], holes: [[[lat,lon]…]], kind }.

/** IGN BD TOPO (France): water surfaces and vegetation zones. */
export async function fetchNatureIGN(lat, lon, radius, log) {
  const proj = makeProjection(lat, lon);
  const [latS, lonW] = proj.toLatLon(-radius * 1.1, -radius * 1.1);
  const [latN, lonE] = proj.toLatLon(radius * 1.1, radius * 1.1);
  const layer = async (name) => {
    const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
      + `&TYPENAMES=BDTOPO_V3:${name}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326`
      + `&BBOX=${latS},${lonW},${latN},${lonE},urn:ogc:def:crs:EPSG::4326&COUNT=3000`;
    const out = [];
    for (const f of (await fetchJson(url)).features || []) {
      const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const [outer, ...holes] = poly.map((ring) => ring.map(([x, y]) => [y, x]));
        if (outer.length >= 4) out.push({ outer, holes, kind: f.properties?.nature || '' });
      }
    }
    return out;
  };
  log('IGN: water and vegetation…');
  const [water, vegetation] = await Promise.all([layer('surface_hydrographique'), layer('zone_de_vegetation')]);
  return { water, vegetation, trees: [], rows: [] };
}

// ---------- Roads ----------
// Road → { line: [[lat,lon]…], width (carriageway, m), lanes, kind: 'road'|'path', sides: {left,right}, bridge, tunnel }

/** IGN BD TOPO road segments (France): real carriageway width, lanes, bridge/tunnel, urban flag. */
export async function fetchRoadsIGN(lat, lon, radius, log) {
  const proj = makeProjection(lat, lon);
  const [latS, lonW] = proj.toLatLon(-radius * 1.1, -radius * 1.1);
  const [latN, lonE] = proj.toLatLon(radius * 1.1, radius * 1.1);
  const PAGE = 4000, out = [];
  log('IGN: roads…');
  for (let start = 0; start < PAGE * 6; start += PAGE) {
    const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
      + '&TYPENAMES=BDTOPO_V3:troncon_de_route&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326'
      + `&BBOX=${latS},${lonW},${latN},${lonE},urn:ogc:def:crs:EPSG::4326&COUNT=${PAGE}&STARTINDEX=${start}`;
    const json = await fetchJson(url, { timeout: 60000 });
    for (const f of json.features || []) {
      const p = f.properties || {};
      const nature = (p.nature || '').toLowerCase();
      if (/bac|liaison maritime|escalier/.test(nature)) continue;
      const path = /sentier|piste cyclable/.test(nature), track = /chemin|empierr/.test(nature);
      const lanes = p.nombre_de_voies > 0 ? p.nombre_de_voies : 0;
      const width = p.largeur_de_chaussee > 0 ? p.largeur_de_chaussee : lanes ? lanes * 3.2 : path ? 1.6 : track ? 3 : 5.5;
      const coords = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : [];
      const urbanStreet = p.urbain === true && !path && !track && !/autorout|bretelle/.test(nature);
      // A dual carriageway is two one-way lines side by side: each gets a sidewalk on its outer side
      // only, i.e. on the right of the traffic (France drives on the right). The line is digitised
      // with the traffic ("Sens direct") or against it ("Sens inverse"). Elsewhere: both sides.
      const sens = (p.sens_de_circulation || '').toLowerCase();
      const dual = /2 chauss/.test(nature) && /sens (direct|inverse)/.test(sens);
      const sides = !urbanStreet ? { left: false, right: false }
        : dual ? (/inverse/.test(sens) ? { left: true, right: false } : { left: false, right: true })
        : { left: true, right: true };
      for (const c of coords) {
        out.push({
          line: c.map(([x, y]) => [y, x]), width: Math.max(1.2, width), lanes, kind: /piste cyclable/.test(nature) ? 'footway' : path || track ? 'path' : 'road',
          measuredWidth: p.largeur_de_chaussee > 0,
          sides,
          bridge: String(p.position_par_rapport_au_sol) === '1', tunnel: String(p.position_par_rapport_au_sol).startsWith('-'),
        });
      }
    }
    if ((json.features || []).length < PAGE) break;
  }
  return out;
}

const OSM_ROAD_WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7, unclassified: 5.5, residential: 6, living_street: 5, service: 4, pedestrian: 6, track: 3, footway: 2, path: 1.6, cycleway: 2, steps: 0 };
function osmRoad(el) {
  const t = el.tags || {};
  const hw = (t.highway || '').replace(/_link$/, '');
  if (!(hw in OSM_ROAD_WIDTH) || hw === 'steps' || !el.geometry) return null;
  const lanes = parseFloat(t.lanes) || 0;
  const width = parseFloat(t.width) || (lanes ? lanes * 3.2 : OSM_ROAD_WIDTH[hw]);
  const path = /footway|path|cycleway|track|pedestrian/.test(hw);
  const sw = (t.sidewalk || t['sidewalk:both'] || '').toLowerCase();
  const defaultSides = /primary|secondary|tertiary|residential|living_street|unclassified/.test(hw) && !sw;
  return {
    line: el.geometry.map((p) => [p.lat, p.lon]), width, lanes: lanes || (width >= 6 ? 2 : 1), kind: path ? 'path' : 'road',
    sides: { left: sw === 'both' || sw === 'left' || defaultSides, right: sw === 'both' || sw === 'right' || defaultSides },
    bridge: t.bridge && t.bridge !== 'no', tunnel: t.tunnel && t.tunnel !== 'no',
  };
}

/**
 * OpenStreetMap (Overpass): individual trees, tree rows, parks/woods/grass, water areas and,
 * when `withRoads` (outside France, where IGN roads aren't available), the street network.
 */
/** Street trees from OpenStreetMap (single trees and tree rows): a small query, so busy servers answer. */
export async function fetchTreesOSM(lat, lon, radius, log = () => {}, timeoutMs = 20000) {
  const a = `(around:${Math.round(radius * 1.1)},${lat},${lon})`;
  const els = await overpass(`[out:json][timeout:30];(node["natural"="tree"]${a};way["natural"="tree_row"]${a};);out geom;`, log, timeoutMs);
  const trees = [], rows = [];
  for (const el of els) {
    if (el.type === 'node') trees.push([el.lat, el.lon, parseFloat(el.tags?.height) || 0]);
    else if (el.geometry) rows.push(el.geometry.map((p) => [p.lat, p.lon]));
  }
  return { trees, rows, host: els.host };
}

export async function fetchNatureOSM(lat, lon, radius, log, timeoutMs = 45000, withRoads = false) {
  const a = `(around:${Math.round(radius * 1.1)},${lat},${lon})`;
  const q = `[out:json][timeout:60];
(
  ${withRoads ? `way["highway"]${a};` : ''}
  node["natural"="tree"]${a};
  way["natural"="tree_row"]${a};
  way["leisure"~"^(park|garden)$"]${a};
  way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground)$"]${a};
  way["natural"~"^(wood|scrub|water)$"]${a};
  way["waterway"="riverbank"]${a};
  relation["natural"~"^(water|wood)$"]${a};
  relation["landuse"="forest"]${a};
  relation["leisure"="park"]${a};
);
out geom;`;
  const elements = await overpass(q, log, timeoutMs);
  const trees = [], rows = [], water = [], vegetation = [], roads = [];
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'node') { trees.push([el.lat, el.lon, parseFloat(t.height) || 0]); continue; }
    if (t.highway) { const r = osmRoad(el); if (r) roads.push(r); continue; }
    const kind = t.natural === 'water' || t.waterway === 'riverbank' ? 'water'
      : t.natural === 'tree_row' ? 'row'
        : t.leisure === 'park' || t.leisure === 'garden' ? 'park'
          : t.landuse === 'forest' || t.natural === 'wood' ? 'wood'
            : t.natural === 'scrub' ? 'scrub' : 'grass';
    if (kind === 'row') { if (el.geometry) rows.push(el.geometry.map((p) => [p.lat, p.lon])); continue; }
    const polys = el.type === 'way'
      ? (el.geometry && isClosed(el.geometry.map((p) => [p.lat, p.lon])) ? [{ outer: el.geometry.map((p) => [p.lat, p.lon]), holes: [] }] : [])
      : relationPolygons(el);
    for (const p of polys) (kind === 'water' ? water : vegetation).push({ ...p, kind });
  }
  return { water, vegetation, trees, rows, roads };
}

/** Multipolygon relation → polygons, stitching member ways end to end into closed rings. */
function relationPolygons(rel) {
  const ways = { outer: [], inner: [] };
  for (const m of rel.members || []) {
    if (m.type === 'way' && m.geometry) (m.role === 'inner' ? ways.inner : ways.outer).push(m.geometry.map((p) => [p.lat, p.lon]));
  }
  const stitch = (parts) => {
    const rings = [], open = parts.map((p) => [...p]);
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    while (open.length) {
      let ring = open.shift();
      let grew = true;
      while (!same(ring[0], ring[ring.length - 1]) && grew) {
        grew = false;
        for (let i = 0; i < open.length; i++) {
          const w = open[i], end = ring[ring.length - 1];
          if (same(w[0], end)) ring = ring.concat(w.slice(1));
          else if (same(w[w.length - 1], end)) ring = ring.concat([...w].reverse().slice(1));
          else if (same(w[w.length - 1], ring[0])) ring = w.concat(ring.slice(1));
          else if (same(w[0], ring[0])) ring = [...w].reverse().concat(ring.slice(1));
          else continue;
          open.splice(i, 1); grew = true; break;
        }
      }
      if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
    }
    return rings;
  };
  const outers = stitch(ways.outer), inners = stitch(ways.inner);
  // each inner ring goes to the outer that contains its first point
  const inside = (pt, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if ((r[i][0] > pt[0]) !== (r[j][0] > pt[0]) && pt[1] < ((r[j][1] - r[i][1]) * (pt[0] - r[i][0])) / (r[j][0] - r[i][0]) + r[i][1]) c = !c; } return c; };
  return outers.map((o) => ({ outer: o, holes: inners.filter((h) => inside(h[0], o)) }));
}

// -> [{ outer: [[lat,lon]...], holes: [[[lat,lon]...]], height, tags }]
function parseBuildings(elements) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const ring = el.geometry.map((p) => [p.lat, p.lon]);
      if (isClosed(ring)) out.push({ outer: ring, holes: [], height: heightOf(tags), heightSource: heightSourceOf(tags), floors: parseFloat(tags["building:levels"]) || 0, ...osmRoof(tags), tags });
    } else if (el.type === 'relation' && el.members) {
      // Prototype: only members that are closed rings on their own (no ring stitching).
      const outers = [], inners = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry) continue;
        const ring = m.geometry.map((p) => [p.lat, p.lon]);
        if (!isClosed(ring)) continue;
        (m.role === 'inner' ? inners : outers).push(ring);
      }
      // Attach all inners to the first outer (crude but fine for a prototype).
      outers.forEach((o, i) => out.push({ outer: o, holes: i === 0 ? inners : [], height: heightOf(tags), heightSource: heightSourceOf(tags), floors: parseFloat(tags["building:levels"]) || 0, ...osmRoof(tags), tags }));
    }
  }
  return out;
}

function isClosed(r) {
  if (r.length < 4) return false;
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/** OSM roof tags → { roofShape, roofRise (-1 = shape known, height not), heightIsTotal } */
function osmRoof(tags) {
  const shape = (tags['roof:shape'] || '').toLowerCase();
  const rh = parseFloat(tags['roof:height']), rl = parseFloat(tags['roof:levels']);
  const rise = rh > 0 ? rh : rl > 0 ? rl * 2.6 : shape && shape !== 'flat' ? -1 : 0;
  // OSM `height` includes the roof; a height derived from building:levels doesn't.
  return { roofShape: shape || 'flat', roofRise: rise, heightIsTotal: parseFloat(tags.height) > 0 };
}

function heightOf(tags) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(tags['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return lv * 3 + 1;
  return 7; // default: ~2 floors
}
const heightSourceOf = (tags) => (parseFloat(tags.height) > 0 || parseFloat(tags['building:levels']) > 0 ? 'mapped' : 'estimated');

// ---------- Elevation ----------

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// A tile that never answers must not hold the build forever: give up after `ms`.
function loadImage(url, ms = 20000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; reject(new Error('tile timed out: ' + url)); }, ms);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('tile failed: ' + url)); };
    img.src = url;
  });
}

// ---------- National elevation models (sharper than the worldwide tiles) ----------

/** Minimal GeoTIFF reader: uncompressed float32, strips or tiles (what ArcGIS exportImage returns). */
function readFloatTiff(buf) {
  const dv = new DataView(buf), le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12, tag = u16(o), type = u16(o + 2), count = u32(o + 4);
    if (type !== 3 && type !== 4) continue; // only SHORT / LONG tags are needed
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? o + 8 : u32(o + 8);
    tags[tag] = Array.from({ length: count }, (_, k) => (type === 3 ? u16(at + k * 2) : u32(at + k * 4)));
  }
  const W = tags[256][0], H = tags[257][0];
  if ((tags[259]?.[0] ?? 1) !== 1 || tags[258]?.[0] !== 32 || (tags[339]?.[0] ?? 1) !== 3) throw new Error('GeoTIFF: not uncompressed float32');
  const out = new Float32Array(W * H);
  const f32 = (o) => dv.getFloat32(o, le);
  if (tags[322]) { // tiled
    const tw = tags[322][0], th = tags[323][0], across = Math.ceil(W / tw);
    tags[324].forEach((off, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th && ty + y < H; y++) for (let x = 0; x < tw && tx + x < W; x++) out[(ty + y) * W + tx + x] = f32(off + (y * tw + x) * 4);
    });
  } else { // strips
    const rows = tags[278]?.[0] ?? H;
    tags[273].forEach((off, s) => {
      for (let y = 0; y < rows && s * rows + y < H; y++) for (let x = 0; x < W; x++) out[(s * rows + y) * W + x] = f32(off + (y * W + x) * 4);
    });
  }
  return { W, H, data: out };
}

/** Bilinear sampler over a W×H grid covering [lonW, lonE] × [latS, latN] (pixel centres). */
function gridSampler(h, W, H, lonW, lonE, latS, latN) {
  const at = (i, j) => h[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  return (lat, lon) => {
    const gx = ((lon - lonW) / (lonE - lonW)) * W - 0.5, gy = ((latN - lat) / (latN - latS)) * H - 0.5;
    const i = Math.floor(gx), j = Math.floor(gy), ax = gx - i, ay = gy - j;
    return (at(i, j) * (1 - ax) + at(i + 1, j) * ax) * (1 - ay) + (at(i, j + 1) * (1 - ax) + at(i + 1, j + 1) * ax) * ay;
  };
}

// United States (incl. Alaska, Hawaii, Puerto Rico): rough boxes for USGS 3DEP (it answers no-data outside)
const US_BOXES = [[24.4, -125, 49.5, -66.8], [51, -180, 71.5, -129], [18.8, -160.4, 22.4, -154.7], [17.8, -67.4, 18.6, -65.2]];
export const inUS = (lat, lon) => US_BOXES.some(([a, b, c, d]) => lat >= a && lat <= c && lon >= b && lon <= d);
export const inJapan = (lat, lon) => lat >= 24 && lat <= 45.6 && lon >= 122.9 && lon <= 146;

/**
 * United States: USGS 3DEP, the best model available at each spot (1 m lidar in most of the
 * country, 10 m elsewhere), as one float32 GeoTIFF from the public ImageServer (no key).
 */
export async function fetchElevationUSGS(proj, radius, log) {
  const half = radius * 1.25;
  const [latN, lonW] = proj.toLatLon(-half, half);
  const [latS, lonE] = proj.toLatLon(half, -half);
  const W = Math.min(1024, Math.max(256, Math.ceil((2 * half) / 1.5)));
  // EPSG:4326 in and out: the grid is regular in lat/lon, as the sampler expects
  const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
    + `?bbox=${lonW},${latS},${lonE},${latN}&bboxSR=4326&imageSR=4326&size=${W},${W}&format=tiff&pixelType=F32`
    + '&interpolation=RSP_BilinearInterpolation&compression=None&f=image';
  log('Elevation: USGS 3DEP…');
  const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!r.ok || !/tiff/.test(r.headers.get('content-type') || '')) throw new Error(`USGS 3DEP: HTTP ${r.status}`);
  const { W: w, H: hgt, data } = readFloatTiff(await r.arrayBuffer());
  let bad = 0;
  for (let i = 0; i < data.length; i++) if (!(data[i] > -500 && data[i] < 9000)) { data[i] = NaN; bad++; }
  if (bad > data.length * 0.3) throw new Error('USGS 3DEP: outside coverage');
  if (bad) fillHoles(data, 0);
  return gridSampler(data, w, hgt, lonW, lonE, latS, latN);
}

const fillHoles = (h, value) => { for (let i = 0; i < h.length; i++) if (Number.isNaN(h[i])) h[i] = value; };

/** Japan: GSI DEM 5 m (DEM5A, PNG tiles at zoom 15), the 10 m DEM where the 5 m one has gaps. */
export async function fetchElevationGSI(proj, radius, log) {
  log('Elevation: GSI DEM 5 m…');
  const decode = (d, i) => { // GSI PNG elevation: 24-bit signed hundredths of a metre; 2^23 = no data
    const x = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
    return x === 8388608 ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
  };
  return tileSampler(proj, radius, 15, (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`, decode,
    (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z - 1}/${x >> 1}/${y >> 1}.png`);
}

/**
 * A bilinear sampler over 256-px elevation tiles at zoom z. decode(rgba, i) → metres or NaN.
 * fallback(z, x, y): the parent tile (zoom z-1) used where a tile is missing or has holes; what
 * neither has (the sea) is 0. Throws if no tile at all answered.
 */
async function tileSampler(proj, radius, z, url, decode, fallback = null) {
  const [latN, lonW] = proj.toLatLon(-radius * 1.2, radius * 1.2);
  const [latS, lonE] = proj.toLatLon(radius * 1.2, -radius * 1.2);
  const x0 = Math.floor(lon2x(lonW, z)), x1 = Math.floor(lon2x(lonE, z));
  const y0 = Math.floor(lat2y(latN, z)), y1 = Math.floor(lat2y(latS, z));
  const pixels = async (u) => {
    const img = await loadImage(u);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 256, 256);
    const d = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
    for (let i = 0; i < h.length; i++) h[i] = decode(d, i * 4);
    return h;
  };
  const tiles = new Map();
  let answered = 0;
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push((async () => {
    let h = await pixels(url(z, x, y)).catch(() => null);
    if (h) answered++;
    if ((!h || h.some(Number.isNaN)) && fallback) {
      const f = await pixels(fallback(z, x, y)).catch(() => null);
      if (f) {
        answered++;
        h ||= new Float32Array(65536).fill(NaN);
        const ox = (x & 1) * 128, oy = (y & 1) * 128;
        for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) if (Number.isNaN(h[j * 256 + i])) h[j * 256 + i] = f[(oy + (j >> 1)) * 256 + ox + (i >> 1)];
      }
    }
    h ||= new Float32Array(65536).fill(0);
    fillHoles(h, 0);
    tiles.set(`${x}/${y}`, h);
  })());
  await Promise.all(jobs);
  if (!answered) throw new Error('no elevation tile answered');
  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), t = tiles.get(`${tx}/${ty}`);
    if (!t) return 0;
    return t[Math.min(255, Math.max(0, gy - ty * 256)) * 256 + Math.min(255, Math.max(0, gx - tx * 256))];
  };
  return (lat, lon) => {
    const gx = lon2x(lon, z) * 256 - 0.5, gy = lat2y(lat, z) * 256 - 0.5;
    const fx = Math.floor(gx), fy = Math.floor(gy), ax = gx - fx, ay = gy - fy;
    return (px(fx, fy) * (1 - ax) + px(fx + 1, fy) * ax) * (1 - ay) + (px(fx, fy + 1) * (1 - ax) + px(fx + 1, fy + 1) * ax) * ay;
  };
}

// ---------- Imagery ----------

// Open aerial photos, no key. `box` = rough coverage [south, west, north, east]; "auto" takes the
// first source covering the place whose tiles aren't empty, else the worldwide satellite mosaic.
export const IMAGERY = {
  ign: {
    label: 'IGN BD ORTHO (France, 20 cm)', covers: inFrance, maxZoom: 19,
    url: (z, x, y) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`,
    attribution: 'Imagery: © IGN BD ORTHO – Licence Ouverte Etalab 2.0',
  },
  naip: {
    // one image for the whole area (ArcGIS ImageServer), at the photos' native ~60 cm
    label: 'USGS NAIP (United States, 60 cm)', box: [24.4, -125, 49.5, -66.8], native: 0.6,
    bbox: (w, s, e, n, px) => `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${w},${s},${e},${n}&bboxSR=3857&imageSR=3857&size=${px},${px}&format=jpg&f=image`,
    attribution: 'Imagery: USGS NAIP (public domain)',
  },
  pdok: {
    label: 'PDOK aerial photo (Netherlands, 25 cm)', box: [50.7, 3.3, 53.6, 7.3], maxZoom: 19,
    url: (z, x, y) => `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/${z}/${x}/${y}.jpeg`,
    attribution: 'Imagery: Beeldmateriaal.nl / PDOK – CC BY 4.0',
  },
  swiss: {
    label: 'swisstopo SWISSIMAGE (Switzerland, 10 cm)', box: [45.8, 5.9, 47.85, 10.5], maxZoom: 19,
    url: (z, x, y) => `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`,
    attribution: 'Imagery: © swisstopo (SWISSIMAGE)',
  },
  austria: {
    label: 'basemap.at orthophoto (Austria, 30 cm)', box: [46.35, 9.5, 49.05, 17.2], maxZoom: 19,
    url: (z, x, y) => `https://maps.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${z}/${y}/${x}.jpeg`,
    attribution: 'Imagery: basemap.at – CC BY 4.0',
  },
  pnoa: {
    label: 'PNOA (Spain, 25 cm)', box: [27.5, -18.5, 43.9, 4.4], maxZoom: 19,
    url: (z, x, y) => `https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
    attribution: 'Imagery: PNOA cedido por © Instituto Geográfico Nacional de España – CC BY 4.0',
  },
  gsi: {
    label: 'GSI seamless photo (Japan)', box: [24, 122.9, 45.6, 146], maxZoom: 18,
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
    attribution: 'Imagery: Geospatial Information Authority of Japan (GSI)',
  },
  esri: {
    // worldwide, ~30-60 cm in most cities (Maxar, Earthstar, local agencies); zoom 18 exists almost everywhere
    label: 'Esri World Imagery (worldwide)', maxZoom: 18,
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  s2: {
    label: 'Sentinel-2 cloudless (worldwide, 10 m)', maxZoom: 15, coarse: true, dark: true,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`,
    attribution: 'Imagery: Sentinel-2 cloudless 2020 by EOX – CC BY-NC-SA 4.0',
  },
};
// sharpest first: national programmes at 10-30 cm, then Esri (sharper than NAIP's 60 cm in US cities), then NAIP
const AUTO_ORDER = ['ign', 'swiss', 'pdok', 'austria', 'pnoa', 'gsi', 'esri', 'naip'];

const MAX_TILES = 200;  // per build, to stay polite with tile servers (13 x 13 zoom-17 tiles cover a 1 km radius)
const MAX_TEX = 4096;   // output texture size cap (keeps the GLB light)
const ROOF_RES = 0.9;   // metres per pixel the photo needs for roofs to read (mesh.js drapes it up to 1.2 m)

/** Imagery candidates for a place: one key, or for 'auto' the covering national sources then Sentinel-2. */
export function imageryCandidates(key, lat, lon) {
  if (key !== 'auto') return [key];
  const inBox = (b) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
  return [...AUTO_ORDER.filter((k) => (IMAGERY[k].covers ? IMAGERY[k].covers(lat, lon) : !IMAGERY[k].box || inBox(IMAGERY[k].box))), 's2'];
}

/**
 * A square canvas covering local [-size, size] in east and north, north up, from `key` (or the best
 * source for 'auto'). The canvas carries attribution, label, metresPerPixel (texture) and
 * sourceRes (metres per pixel of the photo itself).
 */
export async function fetchImagery(proj, size, key, log) {
  const [lat, lon] = proj.toLatLon(0, 0);
  let lastErr = null;
  for (const k of imageryCandidates(key, lat, lon)) {
    try {
      const out = await fetchImageryFrom(proj, size, k, log);
      if (looksEmpty(out)) throw new Error(`${IMAGERY[k].label}: no photo here`);
      return out;
    } catch (e) { lastErr = e; console.warn('[ogw] imagery', k, e.message); }
  }
  throw lastErr || new Error('no imagery');
}

// a source that covers its country's box but not this spot answers blank (white/black/one colour)
function looksEmpty(canvas) {
  const s = document.createElement('canvas');
  s.width = s.height = 32;
  const ctx = s.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let flat = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v; sum2 += v * v;
    if (v > 248 || v < 4 || (Math.abs(d[i] - 119) < 3 && Math.abs(d[i + 1] - 119) < 3)) flat++; // #777 = failed tiles
  }
  const n = d.length / 4, sd = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
  return flat > n * 0.5 || sd < 4;
}

const MERC = 20037508.342789244;
const toMerc = (lat, lon) => [(lon / 180) * MERC, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / Math.PI) * MERC];

async function fetchImageryFrom(proj, size, key, log) {
  const src = IMAGERY[key];
  const [latN, lonW] = proj.toLatLon(-size, size);
  const [latS, lonE] = proj.toLatLon(size, -size);
  const cosLat = Math.cos((((latN + latS) / 2) * Math.PI) / 180);

  if (src.bbox) { // one request for the whole square
    const [w, n] = toMerc(latN, lonW), [e, s] = toMerc(latS, lonE);
    const W = Math.min(MAX_TEX, Math.max(512, 2 ** Math.ceil(Math.log2((2 * size) / Math.max(src.native, 0.3)))));
    log(`Imagery: ${src.label}…`);
    const img = await loadImage(src.bbox(w, s, e, n, W), 45000);
    const out = document.createElement('canvas');
    out.width = out.height = W;
    out.getContext('2d').drawImage(img, 0, 0, W, W);
    return Object.assign(out, { attribution: src.attribution, label: src.label, metresPerPixel: (2 * size) / W, sourceRes: Math.max(src.native, (2 * size) / W) });
  }

  // the coarsest zoom that is still sharp enough: about the texture's own pixel (no point fetching
  // finer), but never coarser than ROOF_RES, then coarser only if the tile budget demands it
  const resAt = (zz) => (156543.03 * cosLat) / 2 ** zz;
  const want = Math.min(ROOF_RES, (1.5 * 2 * size) / 2048);
  let z = src.maxZoom, x0, x1, y0, y1;
  while (z > 1 && resAt(z - 1) <= want) z--;
  for (; z > 1; z--) {
    x0 = Math.floor(lon2x(lonW, z)); x1 = Math.floor(lon2x(lonE, z));
    y0 = Math.floor(lat2y(latN, z)); y1 = Math.floor(lat2y(latS, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break;
  }
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  log(`Imagery: loading ${nx * ny} tile(s) at zoom ${z} from ${src.label}…`);

  const mosaic = document.createElement('canvas');
  mosaic.width = nx * 256;
  mosaic.height = ny * 256;
  const mctx = mosaic.getContext('2d');
  mctx.fillStyle = '#777';
  mctx.fillRect(0, 0, mosaic.width, mosaic.height);
  let failed = 0;
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadImage(src.url(z, x, y))
      .then((img) => mctx.drawImage(img, (x - x0) * 256, (y - y0) * 256))
      .catch(() => { failed++; }));
  }
  await Promise.all(jobs);
  if (failed === nx * ny) throw new Error(`${src.label}: no tile answered`);
  if (failed) log(`Imagery: ${failed} tile(s) failed, filled with grey.`);

  // Crop the mosaic to the local square. Mercator is ~linear over a few km, so a plain crop is enough.
  const sx = lon2x(lonW, z) * 256 - x0 * 256, sy = lat2y(latN, z) * 256 - y0 * 256;
  const sw = lon2x(lonE, z) * 256 - x0 * 256 - sx, sh = lat2y(latS, z) * 256 - y0 * 256 - sy;
  let W = 512;
  while (W < Math.max(sw, sh) && W < MAX_TEX) W *= 2;
  const out = document.createElement('canvas');
  out.width = out.height = W;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(mosaic, sx, sy, sw, sh, 0, 0, W, W);
  const tileRes = (156543.03 * cosLat) / 2 ** z; // metres per source pixel at this zoom
  return Object.assign(out, { attribution: src.attribution, label: src.label, coarse: !!src.coarse, dark: !!src.dark,
    metresPerPixel: (2 * size) / W, sourceRes: Math.max(tileRes, src.coarse ? 10 : 0) });
}

/**
 * France: IGN RGE ALTI (bare-ground model, 1 m, no buildings or trees) as one float32 grid from the
 * Géoplateforme WMS (no key). Sharp where the ground is sharp: quay walls, embankments, steps.
 * Returns sampler(lat, lon) -> metres (bilinear), or throws (caller falls back to fetchElevation).
 */
export async function fetchElevationIGN(proj, radius, log) {
  const half = radius * 1.25;
  const [latN, lonW] = proj.toLatLon(-half, half);
  const [latS, lonE] = proj.toLatLon(half, -half);
  const W = Math.min(1024, Math.max(256, Math.ceil((2 * half) / 1.5))); // ~1.5 m per pixel
  const url = 'https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
    + '&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&CRS=EPSG:4326'
    + `&BBOX=${latS},${lonW},${latN},${lonE}&WIDTH=${W}&HEIGHT=${W}&FORMAT=image/x-bil;bits=32`;
  log('Elevation: IGN RGE ALTI…');
  let buf;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: attempt ? 'reload' : 'default' });
      if (!r.ok || !/bil/.test(r.headers.get('content-type') || '')) throw new Error(`IGN elevation: HTTP ${r.status} ${r.headers.get('content-type')}`);
      buf = await r.arrayBuffer();
      if (buf.byteLength !== W * W * 4) throw new Error(`IGN elevation: ${buf.byteLength} bytes`);
      break;
    } catch (e) {
      if (attempt >= 1) throw e;
    } finally { clearTimeout(timer); }
  }
  const dv = new DataView(buf), h = new Float32Array(W * W);
  let missing = 0;
  for (let i = 0; i < h.length; i++) {
    const v = dv.getFloat32(i * 4, true);
    if (!(v > -1000)) { missing++; h[i] = 0; } else h[i] = v; // no data = the sea (RGE ALTI stops at the coast)
  }
  if (missing > h.length * 0.3) throw new Error('IGN elevation: outside coverage');
  const at = (i, j) => h[Math.min(W - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  return (lat, lon) => {
    const gx = ((lon - lonW) / (lonE - lonW)) * W - 0.5, gy = ((latN - lat) / (latN - latS)) * W - 0.5;
    const i = Math.floor(gx), j = Math.floor(gy), ax = gx - i, ay = gy - j;
    return (at(i, j) * (1 - ax) + at(i + 1, j) * ax) * (1 - ay) + (at(i, j + 1) * (1 - ax) + at(i + 1, j + 1) * ax) * ay;
  };
}

// Worldwide: AWS Terrarium tiles at zoom 15 (~3-5 m pixels; the data behind is national lidar in some
// countries, 10-30 m SRTM / EU-DEM elsewhere, a surface model in places, so cities can be lumpy).
// Returns sampler(lat, lon) -> metres above sea level (bilinear).
export async function fetchElevation(proj, radius, log, z = 15) {
  const [latN, lonW] = proj.toLatLon(-radius * 1.2, radius * 1.2);
  const [latS, lonE] = proj.toLatLon(radius * 1.2, -radius * 1.2);
  const x0 = Math.floor(lon2x(lonW, z)), x1 = Math.floor(lon2x(lonE, z));
  const y0 = Math.floor(lat2y(latN, z)), y1 = Math.floor(lat2y(latS, z));
  const tiles = new Map();
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadImage(TERRARIUM(z, x, y)).then((img) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const h = new Float32Array(256 * 256);
      for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      tiles.set(`${x}/${y}`, h);
    }));
  }
  log(`Elevation: loading ${jobs.length} terrain tile(s)…`);
  await Promise.all(jobs);

  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return 0;
    const ix = Math.min(255, Math.max(0, gx - tx * 256)), iy = Math.min(255, Math.max(0, gy - ty * 256));
    return t[iy * 256 + ix];
  };
  return (lat, lon) => {
    const gx = lon2x(lon, z) * 256 - 0.5, gy = lat2y(lat, z) * 256 - 0.5;
    const fx = Math.floor(gx), fy = Math.floor(gy), ax = gx - fx, ay = gy - fy;
    const a = px(fx, fy), b = px(fx + 1, fy), c = px(fx, fy + 1), d = px(fx + 1, fy + 1);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  };
}
