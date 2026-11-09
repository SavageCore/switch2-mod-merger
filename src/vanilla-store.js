/**
 * Vanilla archive persistence (IndexedDB).
 *
 * Browsers never reveal real file paths, so there is no path to remember -
 * instead the file contents are stored, keyed by filename, and restored on
 * the next visit. Everything degrades to empty when storage is unavailable
 * (private mode, old browsers, unit tests under node).
 */

const DB_NAME = 'switch2-mod-merger';
const STORE_NAME = 'vanilla';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
}

function txComplete(tx, db) {
  return new Promise((resolve) => {
    const done = () => {
      db.close();
      resolve();
    };
    tx.oncomplete = done;
    tx.onerror = done;
    tx.onabort = done;
  });
}

/** @returns {Promise<Map<string, Uint8Array>>} filename -> bytes, empty on any failure. */
export async function loadVanillaStore() {
  const out = new Map();
  try {
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const store = db
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => {
        db.close();
        reject(req.error ?? new Error('read failed'));
      };
    });
    for (const row of rows ?? []) {
      if (
        row &&
        typeof row.name === 'string' &&
        row.bytes instanceof Uint8Array
      ) {
        out.set(row.name, row.bytes);
      }
    }
  } catch {
    // Storage unavailable: start empty.
  }
  return out;
}

export async function saveVanillaFile(name, bytes) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ name, bytes, savedAt: Date.now() }, name);
    await txComplete(tx, db);
  } catch {
    // Storage unavailable: uploads still work for this session.
  }
}

export async function deleteVanillaFile(name) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(name);
    await txComplete(tx, db);
  } catch {
    // Nothing to clean up.
  }
}
