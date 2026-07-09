// IndexedDB 封裝：素材庫（assets）與歷史排版（projects）。
// 用 IndexedDB 而非 localStorage，因為圖片/多頁資料可能較大。

const DB = 'hrnews-db';
const VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

const api = (store) => ({
  list: () => run(store, 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0))),
  get: (id) => run(store, 'readonly', (s) => s.get(id)),
  put: (val) => run(store, 'readwrite', (s) => s.put(val)),
  remove: (id) => run(store, 'readwrite', (s) => s.delete(id)),
});

export const assets = api('assets');
export const projects = api('projects');
