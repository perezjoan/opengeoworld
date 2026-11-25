# Changelog

OpenGeoWorld follows [semantic versioning](https://semver.org). Each version is a git tag (`vX.Y.Z`).

## v1.0.1 (2026-11-25)

**Fix**
- Étretat and the Pays de Caux coast (Cap d'Antifer) were outside the simplified France outline, so they got OpenStreetMap buildings, Esri photos and worldwide terrain instead of IGN's measured buildings, 20 cm photos and 1 m terrain. One offshore point added to the outline (`apps/web/src/geo.js`); Normandy, the Channel coast and the borders checked.

## v1.0.0 (2026-11-25)

First public release: any place on Earth as an interactive 3D city, built in the browser from open data, with no API key, no server and nothing to install.

**Pick a Location**
- Search or pick a point on the map, radius 100 m to 1 km; the base map uses OpenFreeMap, or CARTO tiles where the browser blocks OpenFreeMap (Brave Shields).

**Build the 3D Map**
- Buildings from IGN BD TOPO (France, measured heights and roof rises) or OpenStreetMap (vector tiles worldwide, Overpass option), with roofs and a generated photo facade library (stone, render, brick, glass, concrete, industrial, houses, shopfronts).
- Terrain from the sharpest open model for the place: IGN RGE ALTI 1 m (France), USGS 3DEP (US), GSI 5 m (Japan), AWS Terrain Tiles elsewhere.
- Aerial imagery draped on the ground and roofs: IGN, swisstopo, PDOK, basemap.at, PNOA, GSI, Esri World Imagery, NAIP, Sentinel-2; zoom chosen so roofs stay sharp up to 1 km.
- Rivers carved into the terrain with vertical quay walls, including the walls between lower quays and streets; bridges as straight decks across all their pieces, with a stone slab and parapets.
- Roads, sidewalks, railways and trams draped on the terrain; ramps keep their slope; no terrain pokes through the roads.
- Street trees (OpenStreetMap via 5 Overpass servers, added when they arrive), woods and parks; no trees on carriageways.
- Every layer labelled measured, mapped, estimated or generated, with toggles for the generated details.

**Fly / Walk**
- The place opens in the awe engine (by oncyber): drone start, landing and walking with a low-poly avatar at human scale, physics, animated water, live minimap.
- Phone layout with a folding step sheet and touch controls (joystick, swipe to look, ▲ ▼, Fly / Land, Jump).

**Downloads**
- GLB (local metres, georeference and provenance in its metadata), GeoJSON (WGS84, per-feature sources and certainty), 3D Tiles 1.1 (placed on the globe, EGM96 geoid heights).

**Site**
- Static files only (OVH or any host), Urban Geo Analytics branding, About / License / Contact pages, version shown in the app and in `build-info.json`.
