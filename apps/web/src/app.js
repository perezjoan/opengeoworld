// OpenGeoWorld (Urban Geo Analytics): 1. pick a location, 2. build the 3D map from open data, 3. fly / walk in it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { makeProjection, fetchBuildings, fetchBuildingsIGN, fetchElevation, fetchElevationIGN, fetchElevationUSGS, fetchElevationGSI, inUS, inJapan, fetchImagery, fetchNatureIGN, fetchRoadsIGN, fetchTreesOSM } from './data.js';
import { buildModel, terrainHalfSize, alternates } from './mesh.js';
import { loadFacadeLibrary } from './facades.js';
import { saveCurrentPlace } from './place-store.js';
import { fetchOSMVectorTiles, VECTOR_TILES_ATTRIBUTION } from './vectortiles.js';
import { setLibertyStyle } from './basemap.js';
import { placeToGeoJSON, tilesetJson, zip, geoidUndulation } from './export.js';
import { VERSION } from './version.js';

document.querySelectorAll('.app-version').forEach((el) => { el.textContent = `v${VERSION}`; });
import { inFrance } from './geo.js';

// The world app is served from the same site, in the world/ folder next to this page
// (static hosting in production, proxied by serve.mjs in development).
const WORLD_URL = new URL('world/', location.href).href;

const $ = (id) => document.getElementById(id);


const state = {
  step: 1,
  maxStep: 1,         // furthest step reachable
  picked: null,       // { lat, lon, label }
  model: null,        // THREE.Group of the last build
  builtFor: null,     // "lat,lon,radius" the model was built for
  stats: null,        // { count, trees, water, seconds }
  world: null,        // { origin: {lat, lon}, radius } of the place loaded in the world app
  worldApp: { state: 'unknown' }, // 'running' on static hosting; dev reports the Next.js server's state
  busy: false,
  gen: 0,             // bumped by startOver(): results of older builds are dropped
};
const placeKey = () => state.picked && `${state.picked.lat.toFixed(6)},${state.picked.lon.toFixed(6)},${radius()}`;
const modelIsCurrent = () => !!state.model && state.builtFor === placeKey();

// ---------- steps, tabs, log ----------

// Back to the map = start over: drop the downloaded data, the model and the running world (the world
// app keeps rendering in its hidden frame otherwise, and the map gets slow).
function startOver() {
  state.gen++; // a build still running for the old session is discarded when it ends
  cache.key = null; cache.data.clear();
  treesFailed.key = null;
  if (state.model) { scene.remove(state.model); dispose(state.model); }
  state.model = null; state.builtFor = null; state.stats = null; state.maxStep = 1;
  const frame = $('world');
  frame.onload = null;
  frame.src = 'about:blank'; // unloads the world app
  state.worldOpen = false;
  $('worldOverlay').innerHTML = 'Build a place and send it to the world to walk here.';
  $('worldOverlay').classList.remove('hidden');
  $('openTab').classList.add('disabled');
  $('openTab').removeAttribute('href');
  if (minimap.map) { minimap.map.remove(); minimap.map = null; minimap.ready = false; minimap.proj = null; }
  $('minimap').hidden = true;
  $('log').innerHTML = ''; $('facts').innerHTML = '';
  enableTab('view', false); enableTab('walk', false);
}

function goStep(n) {
  if (n === 1 && state.step !== 1) startOver();
  state.step = n;
  state.maxStep = Math.max(state.maxStep, n);
  document.querySelectorAll('[data-step]').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n || (s === 2 && modelIsCurrent() && n !== 2));
  });
  showTab(n === 1 ? 'map' : n === 2 ? (state.model ? 'view' : 'map') : 'walk');
  // phones: the world gets the screen (the sheet folds to its title), the other steps need the panel
  if (phone.matches) setSheet(n === 3);
  $('panel').scrollTop = 0; // each step starts at its top
  refreshButtons();
  if (n === 3) run(walk);
}

// ---------- phones: the panel is a bottom sheet that folds ----------
const phone = window.matchMedia('(max-width: 760px)');
function setSheet(folded) {
  document.body.classList.toggle('sheet-folded', folded);
  $('sheetHandle').setAttribute('aria-expanded', String(!folded));
}
$('sheetHandle').addEventListener('click', () => setSheet(!document.body.classList.contains('sheet-folded')));
// on a phone the active step's title also folds / unfolds the sheet
document.querySelectorAll('.step h2').forEach((h) => h.addEventListener('click', () => {
  if (phone.matches && h.closest('.step').classList.contains('active')) setSheet(!document.body.classList.contains('sheet-folded'));
}));
if (phone.matches) document.querySelector('details.gen')?.removeAttribute('open'); // the long option list starts closed
const canGo = (n) => n === 1 || (n === 2 && !!state.picked) || (n === 3 && modelIsCurrent());
document.querySelectorAll('.stepper li').forEach((li) => li.querySelector('button').addEventListener('click', () => {
  const n = Number(li.dataset.step);
  if (canGo(n) && n !== state.step && (!state.busy || n === 1)) goStep(n);
}));

function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('map').classList.toggle('on', name === 'map');
  $('view').classList.toggle('on', name === 'view');
  $('walkPane').classList.toggle('on', name === 'walk');
  $('fullscreen').hidden = name !== 'walk' || !state.worldOpen;
  if (name === 'map') map.resize();
  if (name === 'walk') minimap.map?.resize();
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

const enableTab = (name, on = true) => { document.querySelector(`.tabs [data-tab="${name}"]`).disabled = !on; };

let current = null; // the running log line
function log(msg, cls = 'run') {
  if (current && current.classList.contains('run')) current.className = 'ok';
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = msg;
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
  current = li;
  console.log('[ogw]', msg);
}
const logDone = (msg) => { if (msg) log(msg, 'ok'); else if (current) current.className = 'ok'; };
const logErr = (msg) => {
  if (current && current.classList.contains('run')) current.className = 'err';
  log(msg, 'err');
};

function refreshButtons() {
  const b = state.busy;
  $('next1').disabled = !state.picked; // going to step 2 is fine during a build (its Build button waits)
  // only the next step is blue: Build until the place is built, then Fly (Rebuild becomes a plain button)
  const built = modelIsCurrent();
  $('build').disabled = b || !state.picked;
  $('build').textContent = b ? 'Building…' : built ? 'Rebuild' : 'Build the 3D map';
  $('build').className = built ? 'secondary' : 'primary';
  $('next2').hidden = !built && !b;
  $('next2').disabled = b || !built || state.worldApp.state !== 'running';
  $('next2').textContent = startMode() === 'drone' ? 'Launch the drone ›' : 'Start walking ›';
  $('reload').disabled = b || !modelIsCurrent();
  $('download').disabled = $('downloadGeojson').disabled = $('download3dtiles').disabled = b || !state.model;
  $('back2').disabled = $('back3').disabled = b;
  // step 1 stays reachable while a build runs (picking another place discards that build's result)
  document.querySelectorAll('.stepper li').forEach((li) => { const n = Number(li.dataset.step); li.querySelector('button').disabled = (b && n !== 1) || !canGo(n); });
  // summaries shown on collapsed steps
  $('sum1').textContent = state.picked ? `${state.picked.label || `${state.picked.lat.toFixed(4)}, ${state.picked.lon.toFixed(4)}`} · ${radius()} m` : '';
  $('sum2').textContent = state.stats && modelIsCurrent() ? `${state.stats.count} buildings · ${state.stats.trees} trees` : '';
  $('sum3').textContent = state.worldOpen ? (startMode() === 'drone' ? 'drone' : 'on foot') : '';
}

// ---------- map (step 1) ----------

const map = new maplibregl.Map({
  container: 'map',
  center: [2.3488, 48.8534], // style: setLibertyStyle below
  attributionControl: window.matchMedia('(max-width: 760px)').matches ? { compact: true } : undefined, // phones: credits behind the (i)
  zoom: 14,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
// phones: the credits stay folded behind the (i) instead of covering the bottom of the map
map.once('load', () => { if (phone.matches) map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'); });
const marker = new maplibregl.Marker({ color: '#f08a24' });
const radius = () => Number($('radius').value);

function circle(lat, lon, r) {
  const p = makeProjection(lat, lon);
  const coords = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    const [la, lo] = p.toLatLon(r * Math.cos(a), r * Math.sin(a));
    coords.push([lo, la]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
}

function drawCircle() {
  if (!state.picked || !map.getSource('buffer')) return;
  map.getSource('buffer').setData(circle(state.picked.lat, state.picked.lon, radius()));
}

// the style comes from setLibertyStyle (OpenFreeMap, or CARTO where the browser blocks it)
map.on('style.load', () => {
  if (map.getSource('buffer')) return;
  map.addSource('buffer', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'buffer-fill', type: 'fill', source: 'buffer', paint: { 'fill-color': '#3f8cff', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'buffer-line', type: 'line', source: 'buffer', paint: { 'line-color': '#3f8cff', 'line-width': 2.5 } });
  drawCircle();
});
setLibertyStyle(map);

function pick(lat, lon, label) {
  state.picked = { lat, lon, label };
  marker.setLngLat([lon, lat]).addTo(map);
  drawCircle();
  $('pickedInfo').textContent = `${label ? label + ' · ' : ''}${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if (state.step !== 1) goStep(1); else refreshButtons();
}

map.on('click', (e) => { if (state.step === 1) pick(e.lngLat.lat, e.lngLat.lng); });
$('radius').addEventListener('input', () => { $('radiusLabel').textContent = `${radius()} m`; drawCircle(); refreshButtons(); });

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('pickedInfo').textContent = 'Searching…';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
    const [hit] = await res.json();
    if (!hit) { $('pickedInfo').textContent = `Nothing found for "${q}".`; return; }
    const lat = Number(hit.lat), lon = Number(hit.lon);
    map.flyTo({ center: [lon, lat], zoom: 16 });
    pick(lat, lon, hit.display_name.split(',').slice(0, 2).join(','));
  } catch (err) {
    $('pickedInfo').textContent = 'Search failed: ' + err.message;
  }
});

// ---------- 3D preview ----------

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd1e5);
scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// local dev only: a handle on the preview for checks and screenshots
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__ogwPreview = { camera, controls, scene, renderer };
new ResizeObserver(() => {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(view);
renderer.setAnimationLoop(() => { if (view.classList.contains('on')) { controls.update(); renderer.render(scene, camera); } });

// ---------- build (step 2) ----------

/**
 * Trees, water and green spaces, every source optional (a slow one never blocks the build):
 *  - water, woods, parks: IGN in France (+ OSM parks), the OSM vector tiles elsewhere;
 *  - street trees: OpenStreetMap single trees and tree rows (Overpass: small query, retried on all servers).
 * osmTiles: () => promise of the vector-tile data (shared with buildings and roads).
 */
async function fetchNature(lat, lon, R, osmTiles) {
  const france = inFrance(lat, lon);
  const [ign, tiles] = await Promise.allSettled([
    france ? fetchNatureIGN(lat, lon, R, () => {}) : Promise.reject(new Error('outside France')),
    osmTiles(),
  ]);
  const I = ign.status === 'fulfilled' ? ign.value : null, T = tiles.status === 'fulfilled' ? tiles.value : null;
  if (!I && !T) return { nature: null, roads: null, note: 'trees & water unavailable (sources not answering)' };
  return {
    nature: {
      water: I?.water?.length ? I.water : T?.water || [],
      // IGN woods/forests/hedges + OSM parks in France; OSM woods, parks and grass elsewhere
      vegetation: [...(I?.vegetation || []), ...((T?.vegetation || []).filter((v) => !I || v.kind === 'park'))],
      trees: [],
      rows: [],
    },
    sources: { water: I?.water?.length ? 'IGN BD TOPO' : T ? 'OSM (vector tiles)' : null, green: [I && 'IGN BD TOPO', T && 'OSM (vector tiles)'].filter(Boolean).join(' + ') },
    tiles: !!T,
    note: [I && 'IGN water & woods', T && 'OSM green & water (vector tiles)'].filter(Boolean).join(', '),
  };
}

// Everything downloaded for a place is kept (as promises) until another place or radius is picked,
// so changing an option re-meshes from memory and only fetches what is new. Failures aren't kept.
const cache = { key: null, data: new Map() };
function cached(name, fetcher, key = placeKey()) {
  if (cache.key !== key) { cache.key = key; cache.data.clear(); }
  if (!cache.data.has(name)) {
    const p = fetcher();
    cache.data.set(name, p);
    p.catch(() => { if (cache.data.get(name) === p) cache.data.delete(name); });
  }
  return cache.data.get(name);
}
const isCached = (name) => cache.key === placeKey() && cache.data.has(name);

// Layers that can be shown/hidden on the built model without rebuilding (mesh names in mesh.js):
// open-data layers, and generated details (each mesh needs every listed checkbox ticked).
const LAYERS = { roads: ['roads', 'sidewalks'], nature: ['trees', 'trees-generated', 'water'], rails: ['railways'] };
const VISIBLE = { roads: ['roads'], sidewalks: ['roads', 'genSidewalks'], trees: ['nature'], 'trees-generated': ['nature', 'genTrees'], water: ['nature'], railways: ['rails'] };
const hasLayer = (layer) => !!state.model && LAYERS[layer].some((n) => state.model.getObjectByName(n));
const originals = new WeakMap();
const TERRAIN_LABEL = { ign: 'IGN RGE ALTI, 1 m bare-ground model', usgs: 'USGS 3DEP (1 m lidar where flown, else 10 m)', gsi: 'GSI DEM, 5 m (10 m in gaps)', aws: 'AWS Terrain Tiles, zoom 15 (national lidar in some countries, 10-30 m elsewhere)' };
// vertical datum of each elevation model (the altitudes in the exports are above it)
const ALT_DATUM = { ign: 'NGF-IGN69 / IGN78 (French levelling)', usgs: 'NAVD88 (US)', gsi: 'TP / JGD2011 vertical (Japan)', aws: 'mean sea level, approx. (EGM96 / national datums)' };
const TERRAIN_CREDIT = { ign: '© IGN RGE ALTI – Licence Ouverte Etalab 2.0', usgs: 'USGS 3D Elevation Program (public domain)', gsi: 'Geospatial Information Authority of Japan (GSI) DEM', aws: 'AWS Terrain Tiles (Mapzen/Tilezen: SRTM, USGS, national models)' };
const treesFailed = { key: null, error: null }; // street trees that could not be fetched for this place
function applyLayers() {
  if (!state.model) return;
  state.model.traverse((o) => {
    const need = VISIBLE[o.name];
    if (need) o.visible = need.every((id) => $(id).checked);
    // generated looks with a plain stand-in: facade photos → plain walls, road markings → plain asphalt
    const plain = alternates.get(o);
    if (plain) {
      if (!originals.has(o)) originals.set(o, o.material);
      o.material = (o.name === 'walls' ? $('genFacades').checked : $('genMarkings').checked) ? originals.get(o) : plain;
    }
  });
}

async function build() {
  const { lat, lon } = state.picked;
  const R = radius();
  const key = placeKey(); // the place this build is for (the user may pick another one meanwhile)
  const gen = state.gen;
  const t0 = performance.now();
  const proj = makeProjection(lat, lon);
  const france = inFrance(lat, lon);
  const imagery = $('imagery').value; // auto: the best open aerial photo for the place (see data.js)

  let src = $('buildingsSrc').value;
  if (src === 'auto') src = france ? 'ign' : 'tiles';

  // OpenStreetMap from vector tiles (fast, a CDN): buildings, roads, water and green spaces in one go.
  const osmTiles = () => cached('osm-tiles', () => fetchOSMVectorTiles(lat, lon, R, () => {}), key);

  // Buildings from the chosen source; if it fails, try the next one (IGN only covers France).
  const getBuildings = async () => {
    const order = src === 'ign' ? ['ign', 'tiles', 'osm'] : src === 'tiles' ? ['tiles', 'osm'] : ['osm', 'tiles'];
    let lastErr;
    for (const s of order) {
      try {
        const b = s === 'ign' ? await fetchBuildingsIGN(lat, lon, R, () => {}) : s === 'tiles' ? (await osmTiles()).buildings : await fetchBuildings(lat, lon, R, () => {});
        if (!b.length && s !== order[order.length - 1]) throw new Error('no buildings');
        return { buildings: b, source: s };
      } catch (e) {
        lastErr = e;
        console.warn(`[ogw] buildings from ${s} failed:`, e.message);
      }
    }
    throw lastErr;
  };

  // Terrain: IGN's 1 m bare-ground model in France (sharp quays and embankments), else the
  // worldwide tiles; IGN failing (or outside its coverage) falls back to the tiles.
  // the best model for the place first: IGN 1 m (France), USGS 3DEP (US, mostly 1 m lidar), GSI 5 m
  // (Japan); the worldwide tiles otherwise, or when the national service fails
  const getElevation = async () => {
    const national = inFrance(lat, lon) ? ['ign', fetchElevationIGN] : inUS(lat, lon) ? ['usgs', fetchElevationUSGS] : inJapan(lat, lon) ? ['gsi', fetchElevationGSI] : null;
    if (national) {
      try { return { sample: await national[1](proj, R, () => {}), source: national[0] }; } catch (e) { console.warn(`[ogw] ${national[0]} elevation failed:`, e.message); }
    }
    return { sample: await fetchElevation(proj, R, () => {}), source: 'aws' };
  };

  // Optional layers are fetched when ticked, and also built when already in memory (then just
  // hidden), so ticking them back on later is instant.
  // Roads: IGN in France, the OSM vector tiles elsewhere (and where IGN has none, near a border).
  // Railways: the vector tiles everywhere.
  const wantRoads = $('roads').checked || isCached(france ? 'roads-ign' : 'osm-tiles');
  const wantRails = $('rails').checked || isCached('osm-tiles');
  const wantNature = $('nature').checked || isCached('nature');
  const fresh = [`buildings-${src}`, $('terrain').checked && 'terrain', imagery !== 'none' && `imagery-${imagery}`,
    wantNature && 'nature', wantRoads && france && 'roads-ign', (wantRoads || wantRails) && 'osm-tiles'].filter((n) => n && !isCached(n));
  log(fresh.length ? 'Fetching buildings, terrain, imagery, roads, trees & water…' : 'Rebuilding from the data already downloaded…');
  // Street trees (OSM, Overpass) are often slow: the build waits a few seconds for them at most;
  // later they are added by a quick re-mesh. A failure is remembered until the next Build click.
  const treesP = wantNature && treesFailed.key !== key
    ? cached('osm-trees', () => fetchTreesOSM(lat, lon, R, (m) => /round 2/.test(m) && console.log('[ogw] street trees: second round'), 40000), key) : null;
  let [{ buildings, source }, terrainData, ortho, natureRes, ignRoads, tilesData, facades] = await Promise.all([
    cached(`buildings-${src}`, getBuildings, key),
    // terrain and imagery are optional: if their service fails, build without them (the log says so)
    $('terrain').checked ? cached('terrain', getElevation, key).catch((e) => { console.warn('[ogw] terrain failed:', e.message); return null; }) : null,
    imagery !== 'none' ? cached(`imagery-${imagery}`, () => fetchImagery(proj, terrainHalfSize(R), imagery, () => {}), key).catch((e) => { console.warn('[ogw] imagery failed:', e.message); return null; }) : null,
    // trees, water, green: IGN / vector tiles (see fetchNature); street trees come separately (treesP)
    wantNature ? cached('nature', () => fetchNature(lat, lon, R, osmTiles), key) : { nature: null, note: '' },
    wantRoads && france ? cached('roads-ign', () => fetchRoadsIGN(lat, lon, R, () => {}), key).catch((e) => { console.warn('[ogw] IGN roads failed:', e.message); return null; }) : null,
    wantRoads || wantRails ? osmTiles().catch((e) => { console.warn('[ogw] vector tiles failed:', e.message); return null; }) : null,
    loadFacadeLibrary(), // photo facade tiles (null → drawn facades)
  ]);
  const elev = terrainData?.sample;
  let trees = { status: !wantNature ? 'off' : treesFailed.key === key ? 'failed' : 'pending', error: treesFailed.key === key ? treesFailed.error : null };
  if (treesP) {
    const got = await Promise.race([treesP.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (got?.v) trees = { status: 'ok', host: got.v.host, data: got.v };
    else if (got?.e) { trees = { status: 'failed', error: got.e.message }; treesFailed.key = key; treesFailed.error = got.e.message; }
  }
  if (trees.data && natureRes.nature) natureRes = { ...natureRes, nature: { ...natureRes.nature, trees: trees.data.trees, rows: trees.data.rows } };
  const srcLabel = source === 'ign' ? 'IGN BD TOPO' : source === 'tiles' ? 'OSM vector tiles' : 'OSM Overpass';
  logDone(`${buildings.length} footprints (${srcLabel})${elev ? `, terrain (${TERRAIN_LABEL[terrainData.source]})` : $('terrain').checked ? ', no terrain (service not answering)' : ''}${ortho ? `, imagery: ${ortho.label}` : imagery !== 'none' ? ', no imagery (service not answering)' : ''}${natureRes.note ? `, ${natureRes.note}` : ''}`);

  log('Building meshes…');
  let ground = () => 0, h0 = null;
  if (elev) {
    h0 = elev(lat, lon);
    ground = (e, n) => { const [la, lo] = proj.toLatLon(e, n); return elev(la, lo) - h0; };
  }
  const roads = wantRoads ? (ignRoads?.length ? ignRoads : tilesData?.roads || null) : null;
  const rails = wantRails ? tilesData?.rails || null : null;
  const res = buildModel({ buildings, proj, ground, radius: R, ortho, nature: wantNature ? natureRes.nature : null, roads, rails, facades,
    // a sharp 1 m model deserves a finer ground mesh (~3 m cells); the tiles don't have that detail
    terrainRes: terrainData && terrainData.source !== 'aws' ? Math.min(256, Math.max(128, Math.ceil((2 * terrainHalfSize(R)) / 3))) : Math.min(200, Math.max(128, Math.ceil((2 * terrainHalfSize(R)) / 4))),
    guessRoofs: $('genRoofs').checked });
  const { group, count, spawn, treeCount, water, roadCount, facts } = res;
  // for the GeoJSON / 3D Tiles exports
  const exportSrc = {
    proj, h0, exportData: res.exportData, roads, rails, vegetation: wantNature ? natureRes.nature?.vegetation : null,
    sources: {
      buildings: srcLabel, roads: roads === ignRoads ? 'IGN BD TOPO' : 'OSM (vector tiles)', rails: 'OSM (vector tiles)',
      trees: 'OSM (Overpass)', water: natureRes.sources?.water || null, green: natureRes.sources?.green || null,
    },
  };
  const natureCredit = wantNature && natureRes.nature && [
    natureRes.note.includes('IGN') && 'Water & vegetation: © IGN BD TOPO – Licence Ouverte Etalab 2.0',
    natureRes.tiles ? `Water & vegetation: ${VECTOR_TILES_ATTRIBUTION}` : natureRes.note.includes('OSM') && 'Trees & parks: © OpenStreetMap contributors (ODbL)',
  ];
  group.userData = {
    generator: `OpenGeoWorld ${VERSION} (Urban Geo Analytics, https://urbangeoanalytics.com)`,
    origin: { lat, lon },
    // where the model sits: the frame, and the ground altitude at the origin (model y = 0)
    origin_alt_m: h0 == null ? null : Math.round(h0 * 100) / 100,
    altitude_datum: terrainData ? ALT_DATUM[terrainData.source] : null,
    frame: 'glTF Y-up, metres; X = east, -Z = north; origin = the picked point (origin) at ground level (origin_alt_m)',
    radius_m: R,
    spawn,
    water,
    ground_extent_m: terrainHalfSize(R),
    buildings_source: source,
    attribution: [
      source === 'ign' ? 'Buildings: © IGN BD TOPO – Licence Ouverte Etalab 2.0' : source === 'tiles' ? `Buildings: ${VECTOR_TILES_ATTRIBUTION}` : 'Buildings: © OpenStreetMap contributors (ODbL)',
      elev && `Terrain: ${TERRAIN_CREDIT[terrainData.source]}`,
      ortho?.attribution,
      ...(natureCredit || []),
      roads && (roads === ignRoads ? 'Roads: © IGN BD TOPO – Licence Ouverte Etalab 2.0' : `Roads: ${VECTOR_TILES_ATTRIBUTION}`),
      rails?.length && `Railways: ${VECTOR_TILES_ATTRIBUTION}`,
    ].filter(Boolean),
  };

  if (placeKey() !== key || state.gen !== gen) { // another place picked, or back to the map, during the build: drop the model
    dispose(group);
    if (state.gen === gen) logDone('The place changed during the build: build the new one.');
    return;
  }
  const samePlace = state.builtFor === key;
  if (state.model) { scene.remove(state.model); dispose(state.model); }
  state.model = group;
  state.exportSrc = exportSrc;
  state.builtFor = key;
  scene.add(group);
  applyLayers();
  if (!samePlace) { // a rebuild of the same place keeps the view
    const top = new THREE.Box3().setFromObject(group).max.y; // start above the tallest building
    camera.position.set(R * 0.9, Math.max(R * 0.8, top * 1.4 + 30), R * 0.9);
    controls.target.set(0, 0, 0);
  }
  sun.position.set(R, R * 1.5, R * 0.6);
  state.stats = { count, trees: treeCount, water: water.length, seconds: (performance.now() - t0) / 1000 };
  logDone(`${count} buildings, ${roadCount} road segments, ${treeCount} trees, ${water.length} water bodies in ${state.stats.seconds.toFixed(1)} s. Look around, then go to step 3. Options apply straight away.`);
  group.userData.provenance = report({ facts, srcLabel, terrainData, ortho, natureRes, ignRoads: roads === ignRoads ? ignRoads : null, roads, count, imagery, trees });
  if (trees.status === 'pending' && treesP) { // still waiting for Overpass: add them when they come
    log('Street trees: Overpass is slow, they will be added when it answers (trying 5 servers, twice).', 'ok');
    const again = () => { if (placeKey() !== key || !modelIsCurrent()) return; if (state.busy) setTimeout(again, 500); else run(build); };
    treesP.then(() => { log('Street trees arrived: adding them…'); again(); }, (e) => { treesFailed.key = key; treesFailed.error = e.message; again(); });
  }

  enableTab('view');
  if (state.step === 2) showTab('view'); // not when the user went back to the map meanwhile
}

/**
 * Where everything in the model comes from, shown under the build log and saved in the GLB:
 * measured (instruments: IGN heights, terrain, photos), mapped (drawn by people: OSM, IGN outlines),
 * estimated (computed from something else) or generated (added so the place looks complete).
 */
function report({ facts, srcLabel, terrainData, ortho, natureRes, ignRoads, roads, count, imagery, trees }) {
  const lines = [];
  const add = (badges, html) => lines.push({ badges: badges.filter(Boolean), html });
  const n = (x) => x.toLocaleString('en');
  const list = (...parts) => parts.filter(Boolean).join(', ');
  const h = facts.heights, rf = facts.roofs, t = facts.trees || { mapped: 0, generated: 0 }, rd = facts.roads;
  add(['mapped'], `<b>Building outlines</b>: ${n(count)} from ${srcLabel}.`);
  add([h.measured && 'measured', h.mapped && 'mapped', h.estimated && 'estimated'],
    `<b>Heights</b>: ${list(h.measured && `${n(h.measured)} measured (IGN)`, h.mapped && `${n(h.mapped)} from mapped heights or floor counts`, h.estimated && `${n(h.estimated)} estimated (no height in the data)`)}.`);
  add([rf.measured && 'measured', rf.mapped && 'mapped', rf.guessed && 'generated'],
    `<b>Roofs</b>: ${list(rf.measured && `${n(rf.measured)} pitched from measured roof heights (shape guessed from the footprint)`, rf.mapped && `${n(rf.mapped)} from mapped roof tags`, rf.guessed && `${n(rf.guessed)} guessed for houses`, rf.flat && `${n(rf.flat)} flat (no roof data)`)}.`);
  add(['generated'], `<b>Facades</b>: ${facts.facades === 'photo library' ? 'generic photo tiles' : 'drawn tiles'} picked from each building's type, height and material: not the real facades.`);
  if (natureRes.nature) {
    const src = natureRes.sources || {};
    const street = trees.status === 'ok' ? (t.mapped ? `${n(t.mapped)} street trees at their mapped positions (OSM via ${trees.host})` : 'no street trees mapped in OSM here')
      : trees.status === 'pending' ? 'street trees still on their way from Overpass (added when it answers)'
        : 'no street trees: no Overpass server answered (5 servers, 2 rounds; Build again to retry)';
    add([t.mapped && 'mapped', t.generated && 'generated', trees.status !== 'ok' && 'missing'],
      `<b>Trees</b>: ${[street, t.generated && `${n(t.generated)} planted at random in woods and parks (${src.green || 'mapped areas'})`].filter(Boolean).join('; ')}.`);
    if (facts.water) add(['mapped', 'estimated'], `<b>Water</b>: ${n(facts.water)} water bodies mapped (${src.water || 'open data'}); their level is estimated from the terrain.`);
  }
  if (roads && rd) {
    add(['mapped'], `<b>Roads</b>: ${n(rd.count)} mapped centrelines (${ignRoads ? 'IGN BD TOPO' : 'OSM vector tiles'}).`);
    add([rd.measuredWidths && 'measured', rd.measuredWidths < rd.count && 'estimated'],
      `<b>Road widths</b>: ${list(rd.measuredWidths && `${n(rd.measuredWidths)} measured (IGN)`, rd.measuredWidths < rd.count && `${n(rd.count - rd.measuredWidths)} from the road class or lane count`)}.`);
    add(['generated'], `<b>Sidewalks</b> on ${n(rd.sidewalks)} streets and <b>centre lines</b> on wide roads: assumed from the street type, not mapped.`);
  }
  if (facts.rails) add(['mapped'], `<b>Railways</b>: ${n(facts.rails)} mapped tracks (OSM vector tiles); ballast and rails drawn on them.`);
  if (terrainData) add(['measured'], `<b>Terrain</b>: ${TERRAIN_LABEL[terrainData.source]}.`);
  if (ortho) add(['measured'], `<b>Aerial imagery</b>: ${ortho.label}${(ortho.sourceRes ?? 0) > 1.2 ? ' (too coarse for roofs: they get material textures)' : ''}.`);
  else if (imagery !== 'none') add(['missing'], '<b>Aerial imagery</b>: no service answered.');
  $('facts').innerHTML = lines.map((l) => `<li>${l.badges.map((b) => `<span class="badge ${b}">${b}</span>`).join('')} ${l.html}</li>`).join('');
  return lines.map((l) => `[${l.badges.join(', ')}] ${l.html.replace(/<[^>]+>/g, '')}`); // plain text for the GLB
}

/** GLB of the place. forWorld: without the water mesh (the world draws animated water itself). */
async function exportGlb(forWorld = false) {
  // GLTFExporter skips invisible objects (onlyVisible): hidden layers stay out of the file too
  const water = forWorld ? state.model.getObjectByName('water') : null;
  const wasVisible = water?.visible;
  if (water) water.visible = false;
  try {
    return await new GLTFExporter().parseAsync(state.model, { binary: true });
  } finally {
    if (water) water.visible = wasVisible;
  }
}

const glbName = () => `place_${state.picked.lat.toFixed(5)}_${state.picked.lon.toFixed(5)}_${radius()}m.glb`;
const startMode = () => document.querySelector('input[name="startMode"]:checked')?.value || 'drone';

// ---------- walk (step 3) ----------

async function walk() {
  if (!modelIsCurrent()) throw new Error('Build the place first (step 2).');
  if (state.worldApp.state !== 'running') throw new Error('The world app is not running yet (see the status at the top right).');
  const glb = await exportGlb(true);
  const ud = state.model.userData;
  const minY = new THREE.Box3().setFromObject(state.model).min.y;
  await saveCurrentPlace(glb, {
    name: glbName(),
    origin: ud.origin,
    radius_m: ud.radius_m,
    spawn: ud.spawn,
    minY,
    water: $('nature').checked ? ud.water : [], // the world draws its animated water from these

    start: startMode(),
    attribution: ud.attribution,
  });
  setWorld({ origin: ud.origin, radius: ud.radius_m });
  openWorld();
}

// ---------- minimap (fed by the game through postMessage) ----------

// The place currently loaded in the world app: where its origin is on Earth. Kept across reloads.
function setWorld(world) {
  state.world = world;
  localStorage.setItem('opengeoworld.world', JSON.stringify(world));
  if (minimap.map) placeWorldOnMinimap();
}
try { state.world = JSON.parse(localStorage.getItem('opengeoworld.world')); } catch { state.world = null; }

const minimap = { map: null, marker: null, arrow: null, proj: null, ready: false };

function ensureMinimap() {
  if (minimap.map || !state.world) return;
  $('minimap').hidden = false;
  minimap.map = new maplibregl.Map({
    container: 'minimapMap',
    center: [state.world.origin.lon, state.world.origin.lat],
    zoom: 16.5,
    interactive: true,
    dragPan: false,          // it follows the player
    dragRotate: false,
    attributionControl: { compact: true },
  });
  minimap.arrow = document.createElement('div');
  minimap.arrow.className = 'player-arrow';
  minimap.marker = new maplibregl.Marker({ element: minimap.arrow, rotationAlignment: 'map' });
  minimap.map.on('style.load', () => {
    if (minimap.map.getSource('area')) return;
    minimap.map.addSource('area', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    minimap.map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#3f8cff', 'line-width': 2, 'line-dasharray': [2, 1] } });
    if (minimap.ready) placeWorldOnMinimap();
  });
  setLibertyStyle(minimap.map);
  minimap.map.on('load', () => {
    minimap.ready = true;
    placeWorldOnMinimap();
    // Credits stay one click away (ⓘ) instead of covering a third of the small map.
    minimap.map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  });
}

function placeWorldOnMinimap() {
  const { origin, radius: r } = state.world;
  minimap.proj = makeProjection(origin.lat, origin.lon);
  if (minimap.ready) minimap.map.getSource('area').setData(circle(origin.lat, origin.lon, r));
}

function onPlayer({ x, z, y, heading, flying }) {
  if (!state.world) return;
  ensureMinimap();
  if (!minimap.proj) minimap.proj = makeProjection(state.world.origin.lat, state.world.origin.lon);
  const [lat, lon] = minimap.proj.toLatLon(x, -z); // model: X east, -Z north
  minimap.marker.setLngLat([lon, lat]).setRotation(heading).addTo(minimap.map);
  minimap.arrow.classList.toggle('flying', !!flying);
  minimap.map.jumpTo({ center: [lon, lat], zoom: flying ? 15.5 : 16.5 });
  const info = $('minimapInfo');
  info.className = flying ? 'flying' : '';
  info.textContent = flying ? `Drone · ${Math.round(y)} m` : 'On foot';
  $('flyToggle').classList.toggle('on', !!flying);
  $('flyToggle').textContent = flying ? 'Land' : '✈ Drone';
}

$('flyToggle').addEventListener('click', () => {
  $('world').contentWindow?.postMessage({ type: 'world:fly' }, location.origin);
  $('world').focus(); // keep the keyboard in the game
});

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== $('world').contentWindow) return;
  if (e.data?.type === 'world:player') onPlayer(e.data);
});

$('minimapToggle').addEventListener('click', () => {
  const c = $('minimap').classList.toggle('collapsed');
  $('minimapToggle').textContent = c ? '+' : '–';
  if (!c) minimap.map?.resize();
});

function openWorld() {
  const src = `${WORLD_URL}?t=${Date.now()}`; // fresh load so the new place is read
  const frame = $('world');
  const overlay = $('worldOverlay');
  overlay.innerHTML = '<div><div class="spinner"></div>Loading the world…</div>';
  overlay.classList.remove('hidden');
  frame.onload = () => { overlay.classList.add('hidden'); frame.focus(); };
  frame.src = src;
  state.worldOpen = true;
  $('openTab').href = src;
  $('openTab').classList.remove('disabled');
  enableTab('walk');
  showTab('walk');
}

// ---------- buttons ----------

async function run(task) {
  if (state.busy) return;
  state.busy = true;
  refreshButtons();
  try {
    await task();
  } catch (err) {
    console.error(err);
    logErr(err.message);
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

// Options apply to the built model straight away: roads / trees & water just show or hide (built
// already, or fetched and added once); terrain, imagery and the buildings source re-mesh from the
// data in memory, fetching only what is new.
for (const layer of Object.keys(LAYERS)) {
  $(layer).addEventListener('change', () => {
    if (!modelIsCurrent()) return;
    if (hasLayer(layer) || !$(layer).checked) { applyLayers(); log(`${$(layer).checked ? 'Showing' : 'Hiding'} ${{ roads: 'roads & sidewalks', nature: 'trees & water', rails: 'railways' }[layer]}.`, 'ok'); return; }
    run(build);
  });
}
for (const id of ['terrain', 'imagery', 'buildingsSrc', 'genRoofs']) { // these change the geometry: re-mesh from memory
  $(id).addEventListener('change', () => { if (modelIsCurrent()) run(build); });
}
for (const id of ['genFacades', 'genTrees', 'genSidewalks', 'genMarkings']) { // these only show / swap
  $(id).addEventListener('change', () => applyLayers());
}

// "Build the 3D map ›": open step 2 and build straight away (its options can be changed afterwards)
$('next1').addEventListener('click', () => { goStep(2); if (!state.busy && !modelIsCurrent()) $('build').click(); });
// a click retries street trees; once built, the panel scrolls to the next step (Fly)
$('build').addEventListener('click', () => run(async () => { $('log').innerHTML = ''; $('facts').innerHTML = ''; treesFailed.key = null; await build(); })
  .then(() => { if (state.step === 2 && modelIsCurrent()) $('next2').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }));
$('next2').addEventListener('click', () => goStep(3));
$('back2').addEventListener('click', () => goStep(1));
$('back3').addEventListener('click', () => goStep(2));
$('reload').addEventListener('click', () => run(walk));
document.querySelectorAll('input[name="startMode"]').forEach((r) => r.addEventListener('change', () => { if (state.step === 3) run(walk); }));
$('download').addEventListener('click', () => run(async () => {
  const blob = new Blob([await exportGlb()], { type: 'model/gltf-binary' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: glbName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}));
// GeoJSON: the place's data in lon/lat (hidden layers stay out, as in the GLB)
const saveBlob = (blob, name) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const baseName = () => glbName().replace(/.glb$/, '');
$('downloadGeojson').addEventListener('click', () => run(async () => {
  const ud = state.model.userData;
  const shown = (layer) => (VISIBLE[layer] || []).every((id) => $(id).checked);
  const gj = placeToGeoJSON({ ...state.exportSrc, show: shown, meta: { ...ud, name: baseName() } });
  saveBlob(new Blob([JSON.stringify(gj)], { type: 'application/geo+json' }), `${baseName()}.geojson`);
}));
// 3D Tiles: the GLB and a tileset.json that places it on the globe, zipped
$('download3dtiles').addEventListener('click', () => run(async () => {
  const ud = state.model.userData;
  const glb = await exportGlb();
  const box = new THREE.Box3().setFromObject(state.model);
  const undulation = await geoidUndulation(ud.origin.lat, ud.origin.lon);
  const tileset = tilesetJson({
    lat: ud.origin.lat, lon: ud.origin.lon, height: (ud.origin_alt_m ?? 0) + (undulation ?? 0),
    box: { half: ud.ground_extent_m, minY: box.min.y, maxY: box.max.y }, glbName: glbName(),
    extras: {
      origin: ud.origin, origin_alt_m: ud.origin_alt_m, altitude_datum: ud.altitude_datum,
      geoid_undulation_m: undulation == null ? null : Math.round(undulation * 100) / 100,
      height_note: undulation == null ? 'Placed at its altitude above sea level, without the geoid correction: it may sit tens of metres off a globe with terrain.' : 'Altitude above sea level + EGM96 geoid undulation = height above the WGS84 ellipsoid.',
      attribution: ud.attribution,
    },
  });
  saveBlob(zip([{ name: 'tileset.json', data: JSON.stringify(tileset, null, 1) }, { name: glbName(), data: glb }]), `${baseName()}_3dtiles.zip`);
}));
$('fullscreen').addEventListener('click', () => $('world').requestFullscreen?.());

// ---------- About / License / Contact ----------

document.querySelectorAll('[data-dialog]').forEach((el) => el.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $(`dlg-${el.dataset.dialog}`).showModal();
}));
document.querySelectorAll('dialog.dlg').forEach((d) => {
  d.querySelector('.dlg-close').addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => { // a click on the backdrop (outside the box) closes it
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
  });
});

// ---------- world app status ----------

async function pollWorldApp() {
  try {
    // Only the local dev server has this API; on the real site don't even ask (no 404 noise).
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('static site');
    const res = await fetch('api/world-status', { cache: 'no-store' });
    if (!res.ok) throw new Error('no dev API');
    state.worldApp = await res.json();
  } catch {
    // Static hosting: no server, the world is plain files next to this page.
    state.worldApp = { state: 'running', static: true };
    $('worldPill').hidden = true;
    refreshButtons();
    return;
  }
  const pill = $('worldPill');
  const labels = {
    running: 'World: ready',
    starting: 'World: starting…',
    stopped: 'World: stopped',
    'not-installed': 'World: run pnpm install first',
    missing: 'World: apps/world not found',
    'server-down': 'web server not reachable',
  };
  pill.textContent = labels[state.worldApp.state] || `World: ${state.worldApp.state}`;
  pill.className = 'pill ' + (state.worldApp.state === 'running' ? 'running' : state.worldApp.state === 'starting' ? 'starting' : 'down');
  pill.title = 'Development world app (Next.js)';
  refreshButtons();
  setTimeout(pollWorldApp, state.worldApp.state === 'running' ? 15000 : 3000);
}
pollWorldApp();
goStep(1);

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
  });
}

// For debugging/automation from the console.
window.opengeoworld = { map, scene, state, pick, goStep };
