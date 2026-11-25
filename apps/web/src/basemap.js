// OpenStreetMap vector tiles (OpenMapTiles schema) for the maps and for building places outside France.
//
// OpenFreeMap first. Some blockers (Brave Shields' default lists) block tiles.openfreemap.org/planet,
// which leaves the maps white and the vector data empty; CARTO's street tiles use the same schema
// (same layers and fields), so they stand in when OpenFreeMap can't be reached.

export const LIBERTY_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const CARTO_TILES = 'https://tiles.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt';
const CARTO_ATTRIBUTION = '<a href="https://carto.com/attributions" target="_blank">© CARTO</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>';

let probe = null;

/** The vector tile source for this visit: { url, provider, label }. Checked once, then cached. */
export function vectorTiles() {
  probe ??= fetch(OFM_TILEJSON, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((tj) => ({ url: tj.tiles[0], provider: 'openfreemap', label: 'OpenFreeMap' }))
    .catch((e) => {
      console.warn('[ogw] OpenFreeMap tiles unreachable (blocked by the browser?), using CARTO:', e.message);
      return { url: CARTO_TILES, provider: 'carto', label: 'CARTO' };
    });
  return probe;
}

/**
 * Give a MapLibre map (created without a style) the Liberty style, on OpenFreeMap or, where the
 * browser blocks it, with its 'openmaptiles' source pointing at CARTO. The check takes a fraction
 * of a second; custom layers go in a 'style.load' handler.
 */
export async function setLibertyStyle(map) {
  const tiles = await vectorTiles();
  if (tiles.provider === 'openfreemap') { map.setStyle(LIBERTY_STYLE); return; }
  map.setStyle(LIBERTY_STYLE, {
    transformStyle: (_, style) => {
      for (const src of Object.values(style.sources)) {
        if (src.type === 'vector' && /openfreemap\.org\/planet/.test(src.url || '')) {
          delete src.url;
          Object.assign(src, { tiles: [CARTO_TILES], minzoom: 0, maxzoom: 14, attribution: CARTO_ATTRIBUTION });
        }
      }
      return style;
    },
  });
}
