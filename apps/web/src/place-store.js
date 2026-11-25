// Hands the built place to the world app through IndexedDB. Both apps are served from the same
// site, so they share the browser's storage: nothing is uploaded anywhere.
// Keep DB_NAME / STORE / KEY in sync with apps/world/src/lib/place.ts.

const DB_NAME = 'opengeoworld';
const STORE = 'places';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Save the place (replaces the previous one). glb: ArrayBuffer, meta: plain object. */
export async function saveCurrentPlace(glb, meta) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ glb: new Blob([glb], { type: 'model/gltf-binary' }), meta, createdAt: Date.now() }, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
  db.close();
}
