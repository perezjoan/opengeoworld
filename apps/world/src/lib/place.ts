// The place to walk in is built by the web app in the visitor's browser and handed over through
// IndexedDB (same origin: the web app and the world are served from the same site). Nothing is
// uploaded anywhere. Keep DB_NAME / STORE / KEY in sync with apps/web/src/place-store.js.

const DB_NAME = "opengeoworld";
const STORE = "places";
const KEY = "current";

export interface PlaceMeta {
  name?: string;
  origin?: { lat: number; lon: number };
  radius_m?: number;
  /** Open spot to start from, model coordinates (Y up, X east, -Z north). */
  spawn?: { x: number; y: number; z: number };
  /** Lowest point of the model (m), to tuck the base terrain under it. */
  minY?: number;
  /** Water bodies (model frame x/z + level), drawn as animated water by the world. */
  water?: { level: number; outer: [number, number][]; holes: [number, number][][] }[];
  /** "drone": start flying above the place (default), "walk": on foot at the spawn point. */
  start?: "drone" | "walk";
  attribution?: string[];
}

export interface StoredPlace {
  glb: Blob;
  meta: PlaceMeta;
  createdAt: number;
}

export interface LoadedPlace {
  url: string; // blob: URL of the GLB
  meta: PlaceMeta;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The place the web app saved last, or null (first visit, private browsing, other site). */
export async function loadCurrentPlace(): Promise<LoadedPlace | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const stored = await new Promise<StoredPlace | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!stored?.glb) return null;
    const blob = stored.glb instanceof Blob ? stored.glb : new Blob([stored.glb], { type: "model/gltf-binary" });
    return { url: URL.createObjectURL(blob), meta: stored.meta ?? {} };
  } catch (err) {
    console.warn("[world] could not read the saved place:", err);
    return null;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Height above the street where the drone starts (m). */
export const DRONE_START_HEIGHT = 45;

/** The base scene's avatar is ~2.65 m tall (capsule 2.7 m): a giant next to real 3 m storeys and
 *  2.2 m shop doors. This brings it to ~1.75 m; the engine scales its collider with it. */
const AVATAR_SCALE = 0.66;

/**
 * Add the place to a base scene: the GLB as a walkable model (mesh collider), the avatar at the
 * spawn point, and the base scene's flat terrain moved under the place's lowest point.
 */
export function applyPlace<T extends { components: Record<string, any> }>(game: T, place: LoadedPlace): T {
  const comps = game.components;
  const { meta } = place;

  comps["place"] = {
    type: "model",
    kit: "cyber",
    id: "place",
    name: meta.name ?? "place.glb",
    mime_type: "model/gltf-binary",
    url: place.url,
    optimized: { high: "", low: "", low_compressed: "" },
    meta: { addedBy: "opengeoworld", placeholder: "" },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    envmap: "scene",
    envmapIntensity: 1,
    animations: {},
    renderMode: "default",
    plugins: [],
    enableAnimation: false,
    opacity: 1,
    enableRealTimeShadow: false,
    useTransparency: false,
    center: false,
    fixedTransform: true,
    collider: {
      enabled: true,
      rigidbodyType: "FIXED",
      colliderType: "MESH",
      isSensor: false,
      dynamicProps: { mass: 1, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0 },
    },
  };

  const avatar = Object.values(comps).find((c: any) => c.type === "avatar");
  if (avatar) avatar.scale = { x: AVATAR_SCALE, y: AVATAR_SCALE, z: AVATAR_SCALE };
  if (avatar && meta.spawn) {
    // Drone start: begin high above the spawn point for an overview of the place.
    const up = meta.start === "walk" ? 0 : DRONE_START_HEIGHT;
    avatar.position = { x: round(meta.spawn.x), y: round(meta.spawn.y + up), z: round(meta.spawn.z) };
  }

  if (typeof meta.minY === "number" && Number.isFinite(meta.minY)) {
    for (const c of Object.values(comps) as any[]) {
      if (c.type === "terrain") c.position = { ...(c.position ?? { x: 0, z: 0 }), y: round(meta.minY - 3) };
    }
  }
  return game;
}
