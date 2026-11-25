// Facades: one repeating tile per style (one bay wide x one storey high) plus shopfront tiles for
// ground floors and roofing textures.
// - Photo library (assets/facades/library.json): several photo tiles per style, generated for this
//   project and released with it (see assets/facades/README.md). Each tile knows its width/height
//   ratio, so a bay is as wide as the photo says, and its average colour, so a building with a known
//   colour gets the closest tile, nudged towards that colour.
// - Drawn tiles (canvas, below): the fallback when the library can't be loaded.
import * as THREE from 'three';

const LIB_BASE = new URL('../assets/facades/', import.meta.url);
const STOREY = 3; // metres: the storey height the photo tiles' aspect ratios refer to
let libPromise = null;

/** Load the photo facade library once (resolves to null if it is missing: drawn tiles are used). */
export function loadFacadeLibrary() {
  return (libPromise ??= (async () => {
    try {
      const r = await fetch(new URL('library.json', LIB_BASE));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const lib = await r.json();
      const loader = new THREE.TextureLoader();
      const entries = [...Object.values(lib.walls).flat(), ...lib.shops, ...Object.values(lib.roofs)];
      await Promise.all(entries.map(async (e) => {
        const t = await loader.loadAsync(new URL(e.file, LIB_BASE).href);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        t.name = `facade-${e.file.replace(/\.\w+$/, '')}`;
        t.userData.mimeType = 'image/jpeg';
        e.texture = t;
      }));
      return lib;
    } catch (err) {
      console.warn('Photo facade library unavailable, using drawn facades:', err);
      libPromise = null; // try again next build
      return null;
    }
  })());
}

const T = 256; // tile size in pixels

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = T;
  return [c, c.getContext('2d')];
}
function noise(ctx, amount = 10, alpha = 0.06) {
  for (let i = 0; i < 900; i++) {
    const g = 128 + (Math.random() - 0.5) * 2 * amount * 8;
    ctx.fillStyle = `rgba(${g},${g},${g},${alpha})`;
    ctx.fillRect(Math.random() * T, Math.random() * T, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
}
function glass(ctx, x, y, w, h, top = '#3a4a58', bottom = '#1f2a33') {
  const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; // reflection streak
  ctx.beginPath(); ctx.moveTo(x, y + h * 0.65); ctx.lineTo(x + w * 0.55, y); ctx.lineTo(x + w * 0.75, y); ctx.lineTo(x, y + h * 0.9); ctx.fill();
}

const DRAW = {
  // Haussmann-like dressed stone: tall French windows, wrought-iron balcony, stone joints.
  stone(ctx) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, T, T);
    ctx.strokeStyle = 'rgba(120,110,95,0.35)'; ctx.lineWidth = 2;
    for (let y = 32; y < T; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(T, y); ctx.stroke(); }
    noise(ctx, 6, 0.05);
    ctx.fillStyle = '#f4efe6'; ctx.fillRect(0, 0, T, 12); // cornice line
    ctx.fillStyle = '#e9e1d2'; ctx.fillRect(72, 26, 112, 196); // surround
    glass(ctx, 82, 36, 92, 180);
    ctx.fillStyle = '#ece6da'; ctx.fillRect(125, 36, 6, 180); ctx.fillRect(82, 110, 92, 5); // mullions
    ctx.strokeStyle = '#2a2a2c'; ctx.lineWidth = 3; // balcony
    ctx.beginPath(); ctx.moveTo(64, 176); ctx.lineTo(192, 176); ctx.stroke();
    for (let x = 68; x <= 188; x += 8) { ctx.beginPath(); ctx.moveTo(x, 176); ctx.lineTo(x, 214); ctx.stroke(); }
    ctx.fillStyle = '#d9d0bf'; ctx.fillRect(60, 214, 136, 8);
  },
  // Painted render with wooden shutters and a sill.
  render(ctx) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, T, T);
    noise(ctx, 10, 0.07);
    ctx.fillStyle = '#f2ede4'; ctx.fillRect(84, 52, 88, 150);
    glass(ctx, 92, 60, 72, 134);
    ctx.fillStyle = '#efe9df'; ctx.fillRect(126, 60, 5, 134); ctx.fillRect(92, 124, 72, 4);
    ctx.fillStyle = '#6f8a7a'; // shutters
    for (const x of [52, 172]) {
      ctx.fillRect(x, 56, 32, 142);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = 62; y < 194; y += 10) ctx.fillRect(x + 3, y, 26, 3);
      ctx.fillStyle = '#6f8a7a';
    }
    ctx.fillStyle = '#d6cfc2'; ctx.fillRect(78, 202, 100, 9); // sill
  },
  // Red brick with white frames and a stone lintel (the brick colour is in the tile).
  brick(ctx) {
    ctx.fillStyle = '#d9cfc6'; ctx.fillRect(0, 0, T, T); // mortar
    for (let r = 0; r < T / 16; r++) {
      for (let c = -1; c < T / 32 + 1; c++) {
        const x = c * 32 + (r % 2 ? 16 : 0), y = r * 16;
        const s = 150 + Math.random() * 30;
        ctx.fillStyle = `rgb(${s + 20},${s * 0.52},${s * 0.4})`;
        ctx.fillRect(x + 1, y + 1, 30, 14);
      }
    }
    ctx.fillStyle = '#e8e2d8'; ctx.fillRect(80, 46, 96, 12); // lintel
    ctx.fillStyle = '#f6f4f0'; ctx.fillRect(84, 58, 88, 146);
    glass(ctx, 92, 66, 72, 130);
    ctx.fillStyle = '#f6f4f0'; ctx.fillRect(126, 66, 5, 130); ctx.fillRect(92, 128, 72, 4);
    ctx.fillStyle = '#e1dbd0'; ctx.fillRect(80, 204, 96, 8);
  },
  // Glass curtain wall with mullions and a floor slab band.
  modern(ctx) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, T, T);
    glass(ctx, 0, 0, T, 228, '#5b7387', '#2c3d4b');
    ctx.fillStyle = '#d7dde2';
    for (const x of [0, 126, 252]) ctx.fillRect(x - 3, 0, 7, 228);
    ctx.fillStyle = '#e9ecef'; ctx.fillRect(0, 228, T, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 228, T, 4);
  },
  // 1960s precast concrete panels with square windows.
  concrete(ctx) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, T, T);
    noise(ctx, 12, 0.08);
    ctx.strokeStyle = 'rgba(90,90,90,0.4)'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, T - 2, T - 2);
    ctx.fillStyle = '#e4e4e0'; ctx.fillRect(56, 50, 144, 140);
    glass(ctx, 64, 58, 128, 124);
    ctx.fillStyle = '#e4e4e0'; ctx.fillRect(126, 58, 5, 124);
  },
  // Corrugated cladding with a high strip window.
  industrial(ctx) {
    for (let x = 0; x < T; x += 12) {
      ctx.fillStyle = (x / 12) % 2 ? '#e6e8ea' : '#f7f8f9';
      ctx.fillRect(x, 0, 12, T);
    }
    glass(ctx, 0, 40, T, 44, '#56687a', '#36444f');
    ctx.fillStyle = '#c9ced3'; ctx.fillRect(0, 84, T, 6);
    for (let x = 0; x < T; x += 64) ctx.fillRect(x, 40, 4, 44);
  },
  // Ground-floor shopfront: sign band and large window (tile = one bay x ground-floor height).
  shop(ctx) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, T, T);
    noise(ctx, 8, 0.05);
    ctx.fillStyle = '#c94f3d'; ctx.fillRect(10, 26, 236, 34); // sign / awning
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let x = 10; x < 246; x += 24) ctx.fillRect(x, 26, 12, 34);
    ctx.fillStyle = '#2b2d30'; ctx.fillRect(14, 70, 228, 186); // frame
    glass(ctx, 20, 76, 216, 180, '#5f7280', '#25313a');
    ctx.fillStyle = '#2b2d30'; ctx.fillRect(160, 76, 6, 180);
  },
};

// bay/tints: drawn tiles only. roofKind: the roof covering when the data doesn't say (pitched roofs).
export const STYLES = {
  stone: { bay: 3.6, tints: ['#efe4cf', '#e8dcc4', '#f4ecdd'], roofKind: 'slate' },
  render: { bay: 3.4, tints: ['#f3e2c6', '#ecd0b0', '#dfe6e8', '#f6f1e8', '#eed9bd'], roofKind: 'tiles' },
  brick: { bay: 3.2, tints: ['#ffffff', '#f3e9e3', '#eadfd6'], roofKind: 'tiles' },
  modern: { bay: 3.0, tints: ['#e3ebf2', '#d4dde5', '#eef1f3'], roofKind: 'zinc' },
  concrete: { bay: 3.2, tints: ['#dcdad4', '#d2cfc6', '#e4e2dc'], roofKind: 'zinc' },
  industrial: { bay: 5.0, tints: ['#d2d6db', '#c4cad0', '#ddd8ce'], roofKind: 'zinc' },
  house: { bay: 3.8, tints: ['#efe3cc', '#f6f1e8', '#e8d6bb'], roofKind: 'tiles' },
};
DRAW.house = DRAW.render; // drawn fallback: the rendered wall with shutters
const SHOP_TINTS = ['#ffffff', '#f7e8c8', '#dbe8f2', '#e9f2dc'];

/** Deterministic 0..1 from a point (same building → same style every build). */
const rand01 = (x, y, k = 0) => {
  const s = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

// IGN BD TOPO building materials (codes from the French land registry "fichiers fonciers"; each
// digit is a material, the first one is the main one). Walls: 1 stone, 2 millstone, 3 concrete,
// 4 brick, 5 breeze block, 6 wood, 9 other. Roofs: 1 tiles, 2 slate, 3 zinc/aluminium, 4 concrete.
const IGN_WALL = { 1: ['stone', null], 2: ['stone', '#d8bf9c'], 3: ['concrete', null], 4: ['brick', null], 5: ['render', '#d9d4c8'], 6: ['render', '#b08a62'] };
// roof kinds: tiles, slate, zinc, flat (gravel / concrete / membrane), grass, glass
const ROOF_COLOUR = { tiles: '#b5643f', slate: '#4f5861', zinc: '#9aa6b0', flat: '#9d9d98', grass: '#6f8f4e', glass: '#8fb3c8' };
const IGN_ROOF = { 1: 'tiles', 2: 'slate', 3: 'zinc', 4: 'flat' };
const OSM_ROOF_MATERIAL = [[/tile|clay/, 'tiles'], [/slate/, 'slate'], [/metal|tin|zinc|copper|steel/, 'zinc'], [/concrete|asphalt|tar|gravel|membrane|bitumen/, 'flat'], [/grass|plant/, 'grass'], [/glass/, 'glass']];

/** Any CSS colour (name or hex) → '#rrggbb' quantised to 4 bits per channel, or null. */
function cssColour(c) {
  if (!c) return null;
  try {
    const col = new THREE.Color().setStyle(String(c).trim().replace(/_/g, ''), THREE.SRGBColorSpace);
    const q = (x) => (Math.round(x * 15) * 17).toString(16).padStart(2, '0');
    return `#${q(col.r)}${q(col.g)}${q(col.b)}`;
  } catch { return null; }
}

/**
 * Pick a style for a building from its tags (IGN usage & materials / OSM building, material,
 * colours), its height and a stable pseudo-random number.
 * Returns { style, pick, shopPick, shop, wallColour?, roofKind?, roofColour? }: pick/shopPick are
 * stable 0..1 numbers the kit turns into a tile variant; colours come from the data only.
 */
export function chooseStyle(b, cx, cy, area = 0, attached = false) {
  const t = b.tags || {};
  const r = rand01(cx, cy), r2 = rand01(cx, cy, 1), r3 = rand01(cx, cy, 2), r4 = rand01(cx, cy, 3);
  const usage = `${t.usage || ''} ${t.building || ''} ${t.nature || ''}`.toLowerCase();
  const mat = `${t['building:material'] || ''} ${t['building:facade:material'] || ''}`.toLowerCase();
  const ignWall = IGN_WALL[String(t.wallMat || '')[0]];
  let style, wallColour = cssColour(t['building:colour'] || t['building:facade:colour']);
  // churches, castles, monuments: dressed stone whatever their height (a 66 m cathedral tower is not an office block)
  const heritage = /relig|eglise|église|chapelle|cathédrale|cathedral|church|chapel|castle|château|chateau|monument|tour, donjon|fort, blockhaus|arc de triomphe|temple|mosque|synagogue/.test(usage);
  // Single-family houses (and their garages / sheds, which look like them, not like warehouses):
  // OSM says so, or a small low building whose use is residential or unknown (IGN "Indifférencié",
  // OSM building=yes): at most 2 storeys, ~10 m, a few hundred m² on the ground.
  const ob = t.building || '', iu = (t.usage || '').trim().toLowerCase(), small = area > 0 && b.height > 0 && (b.floors || 0) <= 2;
  const osmHouse = /^(house|detached|semidetached_house|semi|bungalow|terrace|farm|farmhouse|cabin|villa|hut)$/.test(ob)
    || (/^(yes|residential)$/.test(ob) && !attached && small && b.height <= 9 && area >= 30 && area < 220) // generic: free-standing only
    || (/^(garage|garages|shed|carport)$/.test(ob) && small && area < 80);
  const ignHouse = 'usage' in t && small && (
    (/^(résidentiel|indifférencié|)$/.test(iu) && b.height <= 10 && area < 280)
    || (/annexe/.test(iu) && area < 80 && b.height <= 6)); // garages, sheds
  const house = !heritage && (osmHouse || ignHouse);
  let material = null; // for houses: which kind of house tile (render, brick, stone, wood)
  if (heritage && !/brick/.test(mat)) style = 'stone';
  else if (house) {
    style = 'house';
    material = /brick/.test(mat) ? 'brick' : /stone|sandstone|limestone/.test(mat) ? 'stone' : /wood|timber/.test(mat) ? 'wood'
      : /plaster|render|stucco|concrete|cement/.test(mat) ? 'render'
      : ignWall ? (ignWall[0] === 'render' && ignWall[1] === '#b08a62' ? 'wood' : ignWall[0] === 'concrete' ? 'render' : ignWall[0]) : null;
    if (material === 'brick') wallColour = null;
  }
  else if (/brick/.test(mat)) style = 'brick';
  else if (/glass/.test(mat)) style = 'modern';
  else if (/stone|sandstone|limestone/.test(mat)) style = 'stone';
  else if (/metal|steel|aluminium/.test(mat)) style = 'industrial';
  else if (/concrete|cement|panel/.test(mat)) style = 'concrete';
  else if (/plaster|render|stucco/.test(mat)) style = 'render';
  else if (/wood|timber/.test(mat)) { style = 'render'; wallColour ??= '#b08a62'; }
  else if (/industr|agricol|warehouse|hangar|annexe|garage|shed|silo|serre/.test(usage)) style = 'industrial';
  else if (ignWall) { style = ignWall[0]; if (ignWall[1] && !wallColour) wallColour = ignWall[1]; }
  else if (b.height > 32 || /office|commercial|retail|commerce|services/.test(usage) && r < 0.5) style = r < 0.25 && b.height > 32 ? 'concrete' : 'modern';
  else if (b.height >= 13) style = r < 0.5 ? 'stone' : r < 0.8 ? 'render' : r < 0.92 ? 'brick' : 'concrete';
  else style = r < 0.6 ? 'render' : r < 0.85 ? 'brick' : 'stone';
  if (style === 'brick' && wallColour) wallColour = null; // the brick colour is in the texture

  const rm = (t['roof:material'] || '').toLowerCase();
  const hit = rm && OSM_ROOF_MATERIAL.find(([re]) => re.test(rm));
  const roofKind = hit ? hit[1] : IGN_ROOF[String(t.roofMat || '')[0]] || null;
  const roofColour = cssColour(t['roof:colour']);

  const shop = !heritage && !house && style !== 'industrial' && b.height >= 8 && (/commerc|retail|services|mixed/.test(usage) || (b.height >= 12 && r2 < 0.55));
  return { style, house, material, pick: r3, shopPick: r4, shop, heritage, wallColour, roofKind, roofColour };
}

/** Material colour that makes a photo whose average is `mean` look like `colour` (softened, ≤ 1). */
function tintFor(colour, mean) {
  const c = new THREE.Color(colour), m = new THREE.Color(mean);
  let f = [c.r / Math.max(m.r, 0.02), c.g / Math.max(m.g, 0.02), c.b / Math.max(m.b, 0.02)].map((x) => 1 + (x - 1) * 0.75);
  const k = Math.max(1, ...f);
  f = f.map((x) => Math.max(0.25, x / k));
  return new THREE.Color(f[0], f[1], f[2]);
}
const colourDist = (a, b) => { const x = new THREE.Color(a), y = new THREE.Color(b); return (x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2; };

/**
 * Lazily-built materials, shared by all buildings of one build.
 *   facade(style, pick, colour?) → { material, bay }      bay: metres per tile across
 *   shop(pick, height)           → { material, bay }      one shopfront, `height` metres tall
 *   roof(kind, colour?)          → { material, metres }   metres per texture repeat (0: plain colour)
 * lib: the photo library (loadFacadeLibrary), or null for drawn tiles.
 */
export function createFacadeKit(lib = null) {
  const drawn = drawnKit();
  const materials = {};
  const mat = (key, make) => (materials[key] ??= Object.assign(make(), { name: key }));
  return {
    facade(style, pick, colour = null, material = null) {
      let list = lib?.walls[style];
      // tiles of the right material when the data says which (a brick house gets a brick house tile)
      if (material && list?.some((e) => e.material === material)) list = list.filter((e) => e.material === material);
      if (!list?.length) {
        const tint = Math.floor(pick * STYLES[style].tints.length);
        return { material: drawn.wall(style, tint, colour), bay: STYLES[style].bay };
      }
      // a known colour picks the closest photo; otherwise the stable random pick
      let i = Math.floor(pick * list.length) % list.length;
      if (colour) i = list.reduce((best, e, k) => (colourDist(e.mean, colour) < colourDist(list[best].mean, colour) ? k : best), 0);
      const e = list[i];
      const glassy = style === 'modern';
      const wallMat = mat(`wall-${e.file.replace(/\.\w+$/, '')}${colour ? `-${colour}` : ''}`, () => new THREE.MeshStandardMaterial({
        map: e.texture, color: colour ? tintFor(colour, e.mean) : 0xffffff, roughness: glassy ? 0.4 : 0.9, metalness: glassy ? 0.1 : 0,
        userData: { mean: e.mean }, // its wall colour, for the plain-walls option
      }));
      return { material: wallMat, bay: e.aspect * STOREY };
    },
    shop(pick, height) {
      if (!lib?.shops.length) return { material: drawn.shop(Math.floor(pick * 8)), bay: 3.4 };
      const e = lib.shops[Math.floor(pick * lib.shops.length) % lib.shops.length];
      const material = mat(e.file.replace(/\.\w+$/, ''), () => new THREE.MeshStandardMaterial({ map: e.texture, roughness: 0.6, userData: { mean: e.mean } }));
      return { material, bay: e.aspect * height };
    },
    roof(kind, colour = null) {
      const e = lib?.roofs[kind];
      if (!e) return { material: mat(`roof-${colour || kind}`, () => new THREE.MeshStandardMaterial({ color: colour || ROOF_COLOUR[kind] || ROOF_COLOUR.flat, roughness: 0.9 })), metres: 0 };
      const material = mat(`roof-${kind}${colour ? `-${colour}` : ''}`, () => new THREE.MeshStandardMaterial({
        map: e.texture, color: colour ? tintFor(colour, e.mean) : 0xffffff, roughness: kind === 'zinc' ? 0.55 : 0.9, metalness: kind === 'zinc' ? 0.25 : 0,
      }));
      return { material, metres: e.metres };
    },
  };
}

/** The drawn (canvas) tiles. */
function drawnKit() {
  const textures = {}, materials = {};
  const tex = (name) => {
    if (textures[name]) return textures[name];
    const [c, ctx] = canvas();
    DRAW[name](ctx);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.name = `facade-${name}`;
    t.userData.mimeType = 'image/jpeg';
    return (textures[name] = t);
  };
  return {
    /** colour: a real wall colour from the data ('#rrggbb'), otherwise one of the style's tints. */
    wall(style, tint, colour = null) {
      const key = `wall-${style}-${colour || tint}`;
      if (!materials[key]) {
        materials[key] = new THREE.MeshStandardMaterial({ map: tex(style), color: colour || STYLES[style].tints[tint], roughness: style === 'modern' ? 0.35 : 0.88, metalness: style === 'modern' ? 0.15 : 0 });
        materials[key].name = key;
      }
      return materials[key];
    },
    shop(tint) {
      const key = `shop-${tint % SHOP_TINTS.length}`;
      if (!materials[key]) {
        materials[key] = new THREE.MeshStandardMaterial({ map: tex('shop'), color: SHOP_TINTS[tint % SHOP_TINTS.length], roughness: 0.6 });
        materials[key].name = key;
      }
      return materials[key];
    },
  };
}
