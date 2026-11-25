// Is a point in France (where IGN's open data applies)? A simplified outline of mainland France
// (land borders traced at ~5 km; the coasts are pushed offshore, since only land matters) plus
// Corsica. Close to a border it can be wrong either way: the callers fall back to OpenStreetMap
// when IGN answers with nothing.
const MAINLAND = [ // [lon, lat], clockwise from the North Sea
  [2.45, 51.25], [2.6, 51.07], [2.95, 50.8], [3.25, 50.75], [3.65, 50.45], [4.15, 50.27], [4.2, 49.98], [4.8, 50.15],
  [4.85, 49.8], [5.3, 49.65], [5.8, 49.55], [6.1, 49.47], [6.4, 49.47], [6.75, 49.17], [7.1, 49.15], [7.45, 49.17],
  [8.05, 49.02], [8.22, 48.98], [7.8, 48.55], [7.58, 48.1], [7.6, 47.6], [7.45, 47.47], [7.0, 47.48], [6.85, 47.3],
  [6.45, 47.05], [6.1, 46.75], [6.12, 46.55], [6.06, 46.4], [5.97, 46.2], [6.12, 46.14], [6.3, 46.25], [6.22, 46.33],
  [6.5, 46.45], [6.8, 46.4], [6.85, 46.1], [7.05, 45.9], [6.8, 45.7], [7.15, 45.25], [6.65, 45.0], [7.0, 44.7],
  [6.85, 44.4], [7.7, 44.1], [7.53, 43.78], [7.6, 43.5], [6.5, 42.9], [3.4, 42.9], [3.25, 42.4], [2.7, 42.35],
  [1.9, 42.38], [1.45, 42.6], [0.7, 42.8], [-0.3, 42.78], [-0.75, 42.95], [-1.4, 43.05], [-1.8, 43.35], [-2.2, 43.6],
  [-1.8, 45.8], [-2.6, 46.6], [-3.4, 47.3], [-5.3, 47.9], [-5.3, 48.7], [-3.5, 49.1], [-2.0, 49.0], [-2.1, 49.8],
  [-1.2, 49.85], [0.0, 49.6], [1.3, 50.2], [1.45, 51.0],
];
const CORSICA = [[8.45, 43.1], [9.65, 43.1], [9.65, 41.3], [8.45, 41.3]];

function inside(lon, lat, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export const inFrance = (lat, lon) => inside(lon, lat, MAINLAND) || inside(lon, lat, CORSICA);
