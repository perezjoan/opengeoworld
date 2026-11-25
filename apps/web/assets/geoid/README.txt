egm96-30min.i16 - EGM96 geoid undulation (metres between mean sea level and the WGS84 ellipsoid)

Grid: 0.5 degree, 361 rows (90N to 90S) x 721 columns (180W to 180E), little-endian int16,
decimetres. Bilinear interpolation on it is within 2 m of the full model (0.1 m RMS).

Used by src/export.js to place 3D Tiles exports at the right height: the elevation models give
altitudes above sea level, 3D Tiles expects heights above the ellipsoid.

Source: EGM96 (Earth Gravitational Model 1996), NGA / NASA, public domain; sampled from the
15-minute grid distributed with GeographicLib (egm96-15.pgm).
