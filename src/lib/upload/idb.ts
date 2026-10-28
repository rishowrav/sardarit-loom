/**
 * IndexedDB persistence for upload sessions.
 *
 * The recording blob is stored once; small metadata (chunk progress) is
 * rewritten after every completed chunk. That is what makes uploads
 * resumable after a crash, network loss or page reload — without ever
 * re-recording.
 *
 * All functions degrade gracefully when IndexedDB is unavailable (private
 * mode / storage pressure): the upload then simply cannot survive a reload.
 */

export interface UploadSessionMeta {
  recordingId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  chunkSizeBytes: number;
  partCount: number;
  completedParts: number[];
  thumbnailUploaded: boolean;
  hasBlob: boolean;
  local?: boolean;
  createdAt: string;
}

const DB_NAME = "sardarit-loom-uploads";
const DB_VERSION = 1;
const META_STORE = "sessions";
const BLOB_STORE = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "recordingId" });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open upload database"));
    request.onblocked = () => reject(new Error("Upload database blocked"));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function saveSession(meta: UploadSessionMeta): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE], "readwrite");
      tx.objectStore(META_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("session save failed"));
      tx.onabort = () => reject(tx.error ?? new Error("session save aborted"));
    });
  } catch {
    // Non-fatal: resume-after-reload just won't be available.
  }
}

export async function saveBlob(id: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOB_STORE], "readwrite");
      tx.objectStore(BLOB_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("blob save failed"));
      tx.onabort = () => reject(tx.error ?? new Error("blob save aborted"));
    });
    return true;
  } catch {
    return false;
  }
}

export async function getSession(
  id: string,
): Promise<UploadSessionMeta | null> {
  try {
    const db = await openDb();
    const value = await requestToPromise(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(id),
    );
    return (value as UploadSessionMeta | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<UploadSessionMeta[]> {
  try {
    const db = await openDb();
    const value = await requestToPromise(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll(),
    );
    return (value as UploadSessionMeta[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function getBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const value = await requestToPromise(
      db.transaction(BLOB_STORE, "readonly").objectStore(BLOB_STORE).get(id),
    );
    return (value as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE, BLOB_STORE], "readwrite");
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(BLOB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("session delete failed"));
    });
  } catch {
    // Best effort.
  }
}
