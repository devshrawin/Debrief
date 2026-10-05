// IndexedDB store for audio chunks whose transcription failed, so they can be retried later
// instead of being lost. Shared by the offscreen document and the MOM page (same origin).

const DB = 'debrief';
const STORE = 'pending';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }).createIndex('meetingId', 'meetingId');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// item: { meetingId, src, t, wav: Blob, error }
export const savePending = (item) => run('readwrite', (s) => s.add({ ...item, savedAt: Date.now() }));
export const listPending = (meetingId) => run('readonly', (s) => s.index('meetingId').getAll(meetingId));
export const deletePending = (id) => run('readwrite', (s) => s.delete(id));
export async function deleteAllPending(meetingId) {
  for (const p of await listPending(meetingId)) await deletePending(p.id);
}
