<p align="center"><img src="apps/web/assets/brand/logo.svg" width="96" alt="OpenGeoWorld logo"></p>

<h1 align="center">OpenGeoWorld</h1>

<p align="center"><b>How far can a web browser go?</b><br>
Any place on Earth as an interactive 3D city, built live from open data:<br>
no API key, no server, nothing to install.</p>

<p align="center">
<a href="https://urbangeoanalytics.com/opengeoworld/"><b>Live demo</b></a> ·
<a href="CHANGELOG.md">v1.0.1</a> ·
<a href="LICENSE">MIT License</a> ·
by <a href="https://urbangeoanalytics.com">Urban Geo Analytics</a> ·
based on <a href="https://github.com/oncyberio/awe">awe</a> by <a href="https://oncyber.io">oncyber</a>
</p>

---

## The question

City digital twins usually mean a GIS desktop, a tiling server, a cloud account and an API key per data provider. OpenGeoWorld is a research project by [Urban Geo Analytics](https://urbangeoanalytics.com) that asks the opposite question: **how much of that can a plain web page do on its own?**

Open the page, pick a point anywhere on Earth, and the browser itself:

- **queries ten-odd public open-data services in parallel**: national mapping agencies (IGN in France, USGS in the US, GSI in Japan, swisstopo, PDOK, basemap.at, PNOA), OpenStreetMap through vector tiles and Overpass, worldwide terrain and aerial imagery, with fallbacks when one is down, slow or blocked;
- **decodes the raw formats in JavaScript**: Mapbox vector tiles (protobuf), float32 GeoTIFF and PNG-encoded elevation, WFS GeoJSON, map tiles stitched into one orthophoto;
- **builds the city**: thousands of buildings with their measured heights, roofs and photo facades, a terrain mesh cut into quay walls along rivers, bridges, roads and sidewalks draped on the ground, railways, trees and water;
- **hands it to a game engine in the same page**: physics (Rapier, WebAssembly), a walking avatar and a drone, animated water and a live minimap;
- **exports it** as a textured 3D model (GLB), as GIS data with real coordinates (GeoJSON), or placed on the globe (3D Tiles for Cesium and QGIS).

A 300 m radius in central Paris (about 500 buildings, 200 road segments, 700 trees) builds in **4 to 6 seconds**; a 1 km radius (about 5,700 buildings) in **about 8 seconds** on a laptop. The site itself is plain static files on ordinary web hosting: no backend, no database, no account, no CDN, nothing uploaded. It works on phones too, with touch controls.

Every layer says whether it is **measured**, **mapped**, **estimated** or **generated**, and the generated details can be switched off to see only what the open data says.

## Based on awe, by oncyber

The walkable world runs on **[awe](https://github.com/oncyberio/awe)**, the open-source 3D web engine by **[oncyber](https://oncyber.io)** (MIT). awe is three.js underneath, with a game layer on top: OpenGeoWorld took that layer, kept only the engine core a single-player, serverless city viewer needs, and left the rest of the oncyber platform behind.

- **Kept**: three.js rendering, scene and lighting setup; Rapier physics (WebAssembly) and the character controller (slopes, steps, jumps, landings); VRM avatars and the animation state machine; the input system (keyboard, gamepad, touch joystick, pointer lock); the camera rigs; the asset loaders (Draco, Basis) and GPU detection; the asset command-line tool (`packages/tools`).
- **Removed**: the studio editor; all wallet / NFT / sign-in code (Keplr, Privy, wagmi, ethers, Taquito, Cosmos); Colyseus multiplayer; IPFS uploads; world chunks; the metaverse modules (portal, token gate, chat zone, video screen, seat, lift, music zone, gravity zone); the example games.
- **Replaced**: the oncyber avatar by a generated low-poly avatar at human scale; the Mixamo-derived animations by hand-keyed ones generated in code; the assets loaded from oncyber's CDN by generated files served with the site.
- **Added**: the drone, the animated water, loading the place built by the 3-step page, the link to the page's minimap, and the touch buttons for phones.

Some leftovers remain: the engine's asset list still names optional assets that aren't shipped, and internal docs and comments still mention oncyber. Thank you to the oncyber team for opening their engine.

## Three steps

The stepper at the top goes back to any step already reached.

1. **Pick a Location**: search an address or pick a point on the map, choose a radius (100 m to 1 km), then **Build the 3D map ›**. Coming back to the map starts over: the downloaded data, the model and the running world are dropped.
2. **Build the 3D Map**: buildings (pitched roofs, photo facades and shopfronts in their real materials), terrain, aerial imagery, roads and sidewalks, railways, trees and water are fetched and turned into a light `.glb`, shown in the 3D preview. Options apply straight away: layers show or hide instantly, and terrain, imagery or the buildings source re-mesh from the data already downloaded (kept per place and radius), fetching only what is new. Then **Launch the drone ›**.
3. **Fly / Walk**: the place opens in the 3D world (embedded in the same page), **as a drone hovering above it**; land and walk its streets with a low-poly avatar. Animated rivers and lakes, physics, live minimap.

Controls: **F** drone ↔ on foot. Drone: **WASD** fly, **Space** up, **Shift** down. On foot: **WASD** walk (**Shift** sprints), **Space** jump (twice for a spin). Mouse to look, **Esc** releases the mouse. On a phone: joystick on the left, swipe to look, **▲ ▼** for the drone's height, **Fly / Land** and **Jump** buttons on the right.

### Downloads

Step 3 offers three files, all following the layer toggles:

| File | What | Coordinates | Opens in |
|---|---|---|---|
| `.glb` | The textured 3D model | Local metres: glTF Y-up, X east, -Z north, origin = the picked point at ground level. The root node's `extras` hold `origin` (lat/lon), `origin_alt_m` (ground altitude there), `altitude_datum`, `frame`, `attribution`, `provenance` | Blender, three.js, any glTF viewer |
| `.geojson` | The data: buildings (height above the ground, base height, roof shape and height, ground and top altitudes, floors, usage), roads (kind, width, bridges, sidewalks), railways, trees, water (level), green areas; every feature says where each value comes from (`height_from`, `roof_from`, `width_from`, `position_from`…: measured / mapped / estimated / generated) and its `source` | WGS84 lon/lat (RFC 7946); altitudes in `*_alt_m` | QGIS, ArcGIS, kepler.gl, geojson.io, MapLibre / Mapbox extrusions |
| `_3dtiles.zip` | 3D Tiles 1.1: `tileset.json` + the GLB, placed on the globe (east-north-up frame at the origin) | WGS84 / ECEF; height = altitude + EGM96 geoid undulation (`src/export.js`) | CesiumJS, Cesium ion, QGIS 3D view (3.34+), ArcGIS, Unreal / Unity (Cesium plugins) |

Altitudes are above each elevation model's own vertical datum (NGF-IGN69 in France, NAVD88 in the US, mean sea level elsewhere). 3D Tiles needs heights above the WGS84 ellipsoid: the geoid undulation comes from a 0.5° EGM96 grid in `apps/web/assets/geoid/` (520 KB, loaded only for this export, within 2 m).

### Real or generated, said out loud

After each build, a "Where the data comes from" list labels every layer **measured** (instruments: IGN heights, terrain, aerial photos), **mapped** (drawn by people: OpenStreetMap, IGN outlines and roads), **estimated** (computed from something else: a missing height, a road width from its class, the water level) or **generated** (added so the place looks complete). The same list is saved in the GLB (root node `extras.provenance`) and per feature in the GeoJSON. Generated details have their own toggles, applied instantly (the exports follow them): facade photos (off: plain walls in the tile's colour), guessed house roofs, trees planted in woods and parks (mapped street trees stay), sidewalks, road markings.

**Street trees** come from OpenStreetMap through Overpass, with a small trees-only query raced on 5 public servers and a second, longer round. Overpass is often slow: the build waits 3 seconds at most, and adds them with a quick re-mesh when they arrive.

## Quick start (development)

Requirements: [Node.js](https://nodejs.org/) 20.9 or newer. pnpm runs through `npx`, nothing else to install.

```powershell
npx -y pnpm@10.10.0 install
```

```powershell
npx -y pnpm@10.10.0 dev
```

Open http://localhost:8765. `dev` serves the 3-step page, starts the world app's Next.js dev server (port 3000) and makes it available under `/world/` on the same address, like on the real site. Ctrl+C stops both.

## Build and deploy (OVH or any static host)

1. Build for the folder the site will live in. For `https://your-site.fr/opengeoworld/`:

   ```powershell
   $env:OGW_BASE_PATH="/opengeoworld"; npx -y pnpm@10.10.0 build
   ```

   For the domain root, leave `OGW_BASE_PATH` empty. This writes `dist/` (about 16 MB, mostly WebAssembly decoders, physics, GPU benchmark data and the facade library).

2. Check it locally exactly as a static host will serve it (files only, no logic):

   ```powershell
   npx -y pnpm@10.10.0 preview
   ```

   Open http://localhost:8080/opengeoworld/ and do the 3 steps.

3. Upload the **contents** of `dist/` (including the hidden `.htaccess`) to the matching folder of your hosting with FileZilla or any FTP/SFTP client.

`dist/` contains `index.html` + `src/` (the 3-step app), `assets/` (facades, fonts, logos, geoid), `vendor/` (three.js, MapLibre), `world/` (the world app, static export, with its `engine-assets/`), `build-info.json` (version, base path, build date) and `.htaccess` (MIME types for `.wasm`/`.glb`, compression, long caching for hashed build files, no-cache for the rest). The base path is baked into the world's files: rebuild if you move the site to another folder.

## How it works

```
visitor's browser                                           your host (static files only)
────────────────────────────────────────────────────────    ─────────────────────────────
index.html ──fetch open data──▶ IGN, OSM, USGS, Esri…        index.html, src/*.js, assets/
   decode, build meshes (three.js), export GLB               world/  (HTML, JS, WASM, scene)
   save { GLB, spawn, origin… } in IndexedDB                 .htaccess
world/ (iframe, same site) ──read IndexedDB──▶ awe engine
   (three.js + Rapier physics + VRM avatar) ──▶ walk / fly
```

1. `apps/web/src/data.js` fetches buildings, terrain, imagery, roads, water and vegetation (`src/vectortiles.js` decodes the OpenStreetMap vector tiles, `src/basemap.js` picks OpenFreeMap or CARTO). `src/mesh.js` builds the meshes in a local metric frame (Y up, X east, −Z north, origin = picked point): terrain carved under water and cut into vertical quay walls where the ground has two flat levels, buildings with roofs (`src/roofs.js`) and styled facades (`src/facades.js`), bridges as single straight decks across all their pieces, roads and sidewalks draped on the terrain (`src/roads.js`), low-poly trees kept off the carriageways (`src/nature.js`) and a water mesh; it also finds an open spawn point.
2. `src/app.js` exports a GLB and saves it with its metadata in the browser's IndexedDB (`src/place-store.js`). The page and the world are on the same site, so they share that storage. Nothing leaves the browser. `src/export.js` writes the GeoJSON and the 3D Tiles.
3. The world (`apps/world`, a Next.js static export on the awe engine) loads `data/scene.base.json`, reads the place from IndexedDB (`src/lib/place.ts`), adds it as a walkable mesh collider, puts the avatar at the spawn point and the base terrain under the place.
4. The world posts `{ type: "world:player", x, y, z, heading, flying }` about 10×/s for the minimap; the page can send `{ type: "world:fly", on? }`.

"Open in new tab" works too (same site, same storage). A visitor sees only the places built in their own browser; there is no sharing between visitors.

### Avatar, animations, drone, facades and engine assets (all generated)

| What | Where | Made by |
|---|---|---|
| Avatar: faceted low-poly human (~1,300 triangles), VRM 1.0, 22 bones, ~1.75 m tall in the world | `apps/world/public/engine-assets/vrms/human.vrm` | `apps/world/scripts/gen-avatar.mjs` (mesh, rig and skin weights in code, GLB written by hand) |
| Animations: idle, walk, run, sprint, jump, double jump (spin), falling, landing (soft/hard/roll), hover, sitting | `public/engine-assets/jsons/defaultAnims.json`, `public/assets/anims/` | `scripts/gen-anims.mjs` (keyframed joint angles, three.js clip JSON) |
| Drone: quadcopter with spinning props, blur discs, gimbal, blinking LEDs; tilts into its movement | `apps/world/src/lib/drone.ts` | built at runtime with three.js; replaces the avatar in fly mode (same physics body); the world starts in it, 45 m above the spawn point |
| Animated water: glossy surface with two scrolling wave normal maps and reflections | `apps/world/src/lib/water.ts` | built at runtime from the water polygons the web app hands over (not part of the collision mesh) |
| Photo facade library: dressed stone, painted render, brick, glass/contemporary, 1960s concrete, industrial; single-family houses (render, brick, stone, wood); shopfronts; roof tiles, slate, zinc, gravel. Several variants per style; windows aligned to the real floor count when IGN gives it | `apps/web/assets/facades/` (tiles + `library.json`, see its README) | generated for this project with an open image model and cut into seamless one-bay × one-storey tiles; released with the repo, no attribution needed. `src/facades.js` picks the style from building use, height and material tags |
| Roofs: gabled, hipped, pyramidal (as hipped), skillion, flat; gable walls follow the roof line | `apps/web/src/roofs.js` | IGN: eaves height + (roof max − roof min) as rise, shape guessed from the footprint; OSM: `roof:shape`, `roof:height`/`roof:levels` |
| Roads, sidewalks, bridges: asphalt with a dashed centre line (2+ lanes), paver sidewalks with curbs, gravel paths; bridge decks with a stone slab and parapets | `apps/web/src/roads.js` | ribbons resampled every 2.5 m on the terrain mesh; walkable (part of the collision mesh) |
| Trees: broadleaf, conifer and street trees, faceted | `apps/web/src/nature.js` | planted from OSM trees/tree rows, IGN woods/hedges, OSM parks; kept out of buildings, water and carriageways |
| Font (distance field), noise/normal/water/star textures, grass/grid, studio HDR, avatar picture | `public/engine-assets/` | `scripts/gen-engine-assets.mjs` (procedural; font from Droid Sans Bold outlines) |
| Draco/Basis decoders, GPU benchmark data | `public/engine-assets/js/`, `detect-gpu/` | copied by `gen-engine-assets.mjs` from three.js and detect-gpu |

Regenerate after editing a script, e.g. `node apps/world/scripts/gen-anims.mjs`. Licences of the copied/derived files: `apps/world/public/engine-assets/LICENSES.md`.

## Open data sources

### What "Auto" picks, layer by layer

Each layer is chosen separately for the place you pick: the sharpest open source that covers it first, then the next one when a service doesn't answer or answers blank.

| Layer | Best available, by place | Everywhere else |
|---|---|---|
| Buildings | France: IGN BD TOPO (measured heights and roof rises, materials, use) | OpenStreetMap vector tiles (heights where mapped, else from floor counts or estimated); Overpass as an option for roof shapes and materials |
| Terrain | France: IGN RGE ALTI 1 m · United States: USGS 3DEP (1 m lidar in most of the country) · Japan: GSI 5 m | AWS Terrain Tiles: national models in some countries (England, Canada, New Zealand…), 10-30 m elsewhere |
| Aerial imagery | Switzerland: swisstopo 10 cm · France: IGN 20 cm · Netherlands: PDOK 25 cm · Spain: PNOA 25 cm · Austria: basemap.at 30 cm · Japan: GSI · United States: Esri, then NAIP 60 cm | Esri World Imagery (about 30-60 cm in most cities); Sentinel-2 (10 m) as the last resort |
| Roads | France: IGN BD TOPO (measured widths, lanes) | OpenStreetMap vector tiles (width from class and lanes) |
| Water, woods, parks | France: IGN BD TOPO + OpenStreetMap | OpenStreetMap vector tiles |
| Railways, street trees | OpenStreetMap everywhere (vector tiles; street trees via Overpass) | |
| Base map | OpenFreeMap (CARTO tiles where the browser blocks it) | |

### All sources

| Data | Source | Coverage | Licence |
|---|---|---|---|
| Buildings | [IGN BD TOPO](https://geoservices.ign.fr/bdtopo) (WFS, measured heights) | France | Licence Ouverte Etalab 2.0 |
| Buildings, roads, water, woods, parks | [OpenStreetMap](https://www.openstreetmap.org) from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema, zoom 14): heights and base heights, road classes, bridges / tunnels. Where the browser blocks OpenFreeMap (Brave Shields does), [CARTO](https://carto.com/attributions) street tiles, same schema, stand in | World | ODbL |
| Railways | OpenStreetMap from the same vector tiles: trains, metro and light rail above ground, trams | World | ODbL |
| Buildings (option) | OpenStreetMap via Overpass (5 public servers, first answer wins): slower, but with roof shapes and materials | World | ODbL |
| Terrain | [IGN RGE ALTI](https://geoservices.ign.fr/rgealti) (Géoplateforme WMS, 1 m bare ground) | France | Licence Ouverte Etalab 2.0 |
| Terrain | USGS 3DEP (1 m lidar in most of the US, 10 m elsewhere) | US | public domain |
| Terrain | GSI DEM 5 m (10 m in gaps) | Japan | free with credit |
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (zoom 15; also the fallback) | World | see registry (SRTM, etc.) |
| Geoid | EGM96 (NGA / NASA), 0.5° grid from the GeographicLib distribution: for the 3D Tiles export | World | public domain |
| Imagery | [IGN BD ORTHO](https://geoservices.ign.fr/bdortho) (20 cm) | France | Licence Ouverte Etalab 2.0 |
| Imagery | swisstopo SWISSIMAGE (10 cm), PDOK (25 cm), basemap.at (30 cm), PNOA (25 cm), GSI (Japan), USGS NAIP (60 cm): sharpest first; a source that answers blank falls through to the next | CH, NL, AT, ES, JP, US | CC BY 4.0 / free with credit / public domain |
| Imagery | Esri World Imagery (Esri, Maxar, Earthstar Geographics, GIS User Community) | World | Esri terms of use |
| Imagery | [Sentinel-2 cloudless 2020](https://s2maps.eu) by EOX (last resort) | World | CC BY-NC-SA 4.0 |
| Water, woods, hedges, roads | IGN BD TOPO (surface_hydrographique, zone_de_vegetation, troncon_de_route: width, lanes, bridge/tunnel) | France | Licence Ouverte Etalab 2.0 |
| Street trees, tree rows | OpenStreetMap via Overpass | World | ODbL |
| Base map, search | [OpenFreeMap](https://openfreemap.org) (CARTO where the browser blocks it), [Nominatim](https://nominatim.org) | World | ODbL |

The attribution for the data used is written into every export. These public services have fair-use policies (Nominatim: max 1 request/s; Overpass: shared capacity): fine for a research site, worth revisiting if traffic grows.

## Repository layout

```
apps/
  web/      the 3-step app: plain HTML/JS, no build step; serve.mjs is the dev server only
    assets/facades/   photo facade library (tiles + library.json)
    assets/geoid/     EGM96 0.5° grid (3D Tiles heights)
    assets/brand/     OpenGeoWorld logo (SVG) and the Urban Geo Analytics logo
    assets/fonts/     Inter (subset) and Michroma, SIL Open Font License (OFL.txt)
  world/    the walkable world: Next.js app (static export) on the awe engine
packages/
  engine/   awe: 3D engine on three.js + Rapier physics + VRM avatars
  tools/    asset CLI: add-model / optimize (Draco, meshopt, texture resize), inspect, validate
scripts/
  build.mjs    dist/ for static hosting      preview.mjs   serve dist/ as plain files
```

Dev server settings (`apps/web/serve.mjs`): `WEB_PORT` (8765), `WORLD_URL` (http://localhost:3000, also the world dev server's port), `WORLD_AUTOSTART=0` to run `npx -y pnpm@10.10.0 world` yourself.

```powershell
npx -y pnpm@10.10.0 check
```

```powershell
npx -y pnpm@10.10.0 engine:test
```

## Versions

OpenGeoWorld follows [semantic versioning](https://semver.org): **patch** (1.0.x) for fixes, **minor** (1.x.0) for new features, **major** for changes that break the exports or the way the site is hosted. Each release is a git tag (`v1.0.0`) described in [CHANGELOG.md](CHANGELOG.md); the version shows in the app's About page and in `dist/build-info.json`, and is written into every export.

To release: update the version in `package.json` and `apps/web/src/version.js`, add a section to the changelog, commit, tag `vX.Y.Z`, then build and upload `dist/`.

## Known limits

- Facades are generic photo tiles chosen from the building's type, height and material, not the real facade. Roofs are simple shapes: complex footprints (L/U shapes, courtyards) get a flat roof, and IGN gives the roof height but not its shape.
- The result is only as good as each country's open data (see *What "Auto" picks*). National buildings with measured heights are used in France only so far: elsewhere buildings come from OpenStreetMap, whose vector tiles have no roof shapes or materials. Where no national terrain is used, the worldwide tiles are 10-30 m in many countries, so river banks become slopes and cities can be lumpy. Street trees depend on Overpass answering. Next candidates: the Netherlands' 3D BAG and AHN, swissALTI3D, Japan's PLATEAU.
- The ground is a regular height grid (~3 m cells with IGN terrain, ~4 m otherwise). Quay walls are cut where the ground has two flat levels; the ground beside ramps keeps a smoothed slope.
- Water levels are estimated from the terrain and kept under the bridges.
- The vector tiles carry no building type: a building containing a place of worship, castle or monument point is treated as heritage; there are no church-specific facades yet.
- Roads are separate ribbons: at junctions they overlap; no pedestrian crossings or markings beyond the centre line.
- The avatar is a low-poly mannequin; animations are hand-keyed.
- No sharing of places between visitors (that would need a storage service).

## About Urban Geo Analytics

OpenGeoWorld is made by **[Urban Geo Analytics](https://urbangeoanalytics.com)**, an independent research and consulting practice in spatial analysis, GeoAI and machine learning for cities, and a maker of open-source urban analytics.

- Website: [urbangeoanalytics.com](https://urbangeoanalytics.com)
- Live demo: [urbangeoanalytics.com/opengeoworld](https://urbangeoanalytics.com/opengeoworld/)
- Custom versions, your own data, training or research collaborations: [urbangeoanalytics.com/contact](https://urbangeoanalytics.com/contact/)

## Credits and license

- **Engine**: [awe](https://github.com/oncyberio/awe) by [oncyber](https://oncyber.io) (MIT); see *Based on awe* above for what was kept, removed, replaced and added.
- **Libraries served with the site**: three.js (MIT), MapLibre GL JS (BSD-3-Clause), Rapier (Apache-2.0), three-vrm (MIT).
- **Fonts**: Inter and Michroma (SIL Open Font License 1.1, `apps/web/assets/fonts/OFL.txt`).
- **Data**: the open-data producers listed above, credited in the app (License page) and in every export.

OpenGeoWorld is released under the [MIT License](LICENSE).
