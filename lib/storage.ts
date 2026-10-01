import type { CrawlSnapshot } from "./types";

const DB_NAME = "quet-unfollow-ig-local";
const DB_VERSION = 1;
const STORE = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveSnapshot(snapshot: CrawlSnapshot) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listSnapshots(username: string): Promise<CrawlSnapshot[]> {
  const db = await openDb();
  const snapshots = await new Promise<CrawlSnapshot[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).index("username").getAll(username.toLowerCase());
    request.onsuccess = () => resolve(request.result as CrawlSnapshot[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteSnapshots(username: string) {
  const snapshots = await listSnapshots(username);
  if (!snapshots.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const snapshot of snapshots) store.delete(snapshot.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteSnapshotIds(ids: string[]) {
  if (!ids.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
