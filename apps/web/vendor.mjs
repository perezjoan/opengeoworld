// Third-party browser files the 3-step page loads, served from the site (no CDN).
// URL path (relative to the page) -> file in apps/web/node_modules. Used by serve.mjs (dev) and
// scripts/build.mjs (copied into dist/vendor/).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const nm = fileURLToPath(new URL('./node_modules/', import.meta.url));

export const VENDOR = {
  'vendor/three/three.module.js': join(nm, 'three/build/three.module.min.js'),
  'vendor/three/addons/controls/OrbitControls.js': join(nm, 'three/examples/jsm/controls/OrbitControls.js'),
  'vendor/three/addons/exporters/GLTFExporter.js': join(nm, 'three/examples/jsm/exporters/GLTFExporter.js'),
  'vendor/three/addons/utils/BufferGeometryUtils.js': join(nm, 'three/examples/jsm/utils/BufferGeometryUtils.js'),
  'vendor/maplibre/maplibre-gl.js': join(nm, 'maplibre-gl/dist/maplibre-gl.js'),
  'vendor/maplibre/maplibre-gl.css': join(nm, 'maplibre-gl/dist/maplibre-gl.css'),
};
