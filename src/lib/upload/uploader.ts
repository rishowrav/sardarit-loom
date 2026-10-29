import {
  deleteSession,
  saveBlob,
  saveSession,
  type UploadSessionMeta,
} from "@/lib/upload/idb";

export interface UploadInput {
  blob: Blob;
  thumbnail: Blob | null;
  title: string;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface UploadProgress {
  phase: "preparing" | "uploading" | "finalizing" | "done";
  sentBytes: number;
  totalBytes: number;
  partsDone: number;
  totalParts: number;
  bytesPerSecond: number;
}

export interface UploadStorageResult {
  usedBytes: number;
  limitBytes: number;
  completedCount: number;
}

export interface UploadResult {
  recordingId: string;
  sizeBytes: number;
  storage: UploadStorageResult;
  cleanup: { deletedCount: number; freedBytes: number; errors: string[] };
}

export class UploadAborted extends Error {
  constructor() {
    super("Upload aborted");
    this.name = "UploadAborted";
  }
}

export class UploadFailed extends Error {
  constructor(
    message: string,
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = "UploadFailed";
  }
}

class StaleUploadError extends Error {
  constructor() {
    super("Upload session expired on storage");
    this.name = "StaleUploadError";
  }
}

/**
 * Storage reads/listing are capped (Backblaze B2 daily transaction cap) but
 * writes still work. The session is re-uploaded once so every part ETag is
 * known, which lets the server finalise without ListParts.
 */
class CapExceededError extends Error {
  constructor() {
    super("Storage provider transaction cap exceeded");
    this.name = "CapExceededError";
  }
}

class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

const CONCURRENCY = 2;
const SIGN_AHEAD = 8;

/**
 * MediaRecorder blobs carry codec parameters (e.g.
 * "video/webm;codecs=vp9,opus"). The server stores only the container
 * type, so strip the parameters before sending it.
 */
function normalizeMimeType(type: string): string {
  const base = (type || "video/webm").split(";")[0].trim().toLowerCase();
  return /^video\/[a-z0-9.+-]+$/.test(base) ? base : "video/webm";
}

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "POST",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new UploadAborted();
    }
    throw new UploadFailed(
      `Network error while calling ${path}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  if (!response.ok) {
    let message = `${path} returned ${response.status}`;
    try {
      const data = (await response.json()) as { error?: string; details?: string };
      if (data.error) {
        message = data.details ? `${data.error}: ${data.details}` : data.error;
      }
    } catch {
      // keep default message
    }
    throw new ApiHttpError(response.status, message);
  }
  return (await response.json()) as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new UploadAborted());
      },
      { once: true },
    );
  });
}

function partSize(partNumber: number, totalBytes: number, chunkSize: number): number {
  const start = (partNumber - 1) * chunkSize;
  return Math.max(0, Math.min(chunkSize, totalBytes - start));
}

async function putChunk(
  url: string,
  chunk: Blob,
  signal: AbortSignal | undefined,
): Promise<string> {
  const maxAttempts = 5;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new UploadAborted();
    try {
      const response = await fetch(url, {
        method: "PUT",
        body: chunk,
        signal: signal ?? null,
      });
      if (response.ok) {
        return (response.headers.get("etag") ?? "").replace(/^"|"$/g, "");
      }

      const text = await response.text().catch(() => "");
      if (
        response.status === 404 ||
        text.includes("NoSuchUpload") ||
        text.includes("EntityNotActive")
      ) {
        throw new StaleUploadError();
      }
      lastError = new Error(
        `Chunk upload failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
      if (response.status < 500 && response.status !== 429) {
        // Client errors won't heal by retrying (except stale sessions above).
        if (response.status === 403) {
          // Presigned URL may have expired — surface as stale so it re-signs.
          throw new StaleUploadError();
        }
        lastError = new UploadFailed(lastError.message, response.status !== 401 && response.status !== 403);
        throw lastError;
      }
    } catch (error) {
      if (error instanceof UploadAborted || error instanceof StaleUploadError) {
        throw error;
      }
      if (error instanceof UploadFailed) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new UploadAborted();
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(Math.min(7000, 400 * 2 ** attempt) + Math.random() * 300, signal);
  }

  throw new UploadFailed(
    lastError?.message ?? "Chunk upload failed after retries",
    true,
  );
}

export interface RunUploadOptions {
  /** Resume an existing (persisted) session instead of creating a new one. */
  existing?: UploadSessionMeta | null;
  onProgress: (progress: UploadProgress) => void;
  /** Fired once the server-side recording row exists (fresh uploads). */
  onSessionCreated?: (recordingId: string) => void;
  signal?: AbortSignal;
}

/**
 * Chunked, resumable upload driver:
 *  - multipart URLs are requested a few parts ahead of the transfer,
 *  - two chunks upload in parallel with per-chunk retry/backoff,
 *  - progress survives crashes via IndexedDB, so a failed or closed session
 *    can be resumed without re-recording,
 *  - an expired R2 multipart session triggers one transparent re-start.
 */
export async function runUpload(
  input: UploadInput,
  options: RunUploadOptions,
): Promise<UploadResult> {
  const { onProgress, signal } = options;
  const mimeType = normalizeMimeType(input.blob.type);

  let session = options.existing ?? null;

  if (session && session.sizeBytes !== input.blob.size) {
    // The stored session doesn't match this blob — discard it and start over.
    try {
      await api(`/api/uploads/${session.recordingId}/abort`, { signal });
    } catch {
      // Row may already be gone.
    }
    await deleteSession(session.recordingId);
    session = null;
  }

  const emit = (
    phase: UploadProgress["phase"],
    sent: number,
    bps: number,
    meta: UploadSessionMeta,
  ) =>
    onProgress({
      phase,
      sentBytes: sent,
      totalBytes: meta.sizeBytes,
      partsDone: meta.completedParts.length,
      totalParts: meta.partCount,
      bytesPerSecond: bps,
    });

  if (!session) {
    emit("preparing", 0, 0, placeholderMeta(input, mimeType));

    const initiated = await api<{
      recordingId: string;
      chunkSizeBytes: number;
      partCount: number;
      local?: boolean;
    }>("/api/uploads", {
      body: {
        title: input.title,
        durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
        width: input.width,
        height: input.height,
        sizeBytes: input.blob.size,
        mimeType,
      },
      signal,
    });

    session = {
      recordingId: initiated.recordingId,
      title: input.title,
      mimeType,
      sizeBytes: input.blob.size,
      durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
      width: input.width,
      height: input.height,
      chunkSizeBytes: initiated.chunkSizeBytes,
      partCount: initiated.partCount,
      completedParts: [],
      partEtags: {},
      thumbnailUploaded: false,
      hasBlob: false,
      ...(initiated.local ? { local: true } : {}),
      createdAt: new Date().toISOString(),
    };

    await saveSession(session);
    options.onSessionCreated?.(session.recordingId);
    const blobStored = await saveBlob(session.recordingId, input.blob);
    session.hasBlob = blobStored;
    await saveSession(session);

    // Thumbnail: best-effort, never blocks the video upload.
    if (input.thumbnail && !session.thumbnailUploaded) {
    try {
      const { url } = session.local
        ? { url: `/api/local-thumbnail/${session.recordingId}` }
        : await api<{ url: string }>(
            `/api/uploads/${session.recordingId}/thumbnail`,
            { signal },
          );
        const put = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: input.thumbnail,
          signal: signal ?? null,
        });
        if (put.ok) {
          session.thumbnailUploaded = true;
          await saveSession(session);
        }
      } catch {
        // Ignore — placeholder thumbnail in the library.
      }
    }
  } else {
    emit("preparing", sizeOfCompleted(session), 0, session);
  }

  const activeSession = session;
  let restarted = false;
  let refreshedForCap = false;

  for (;;) {
    try {
      return await uploadParts(activeSession, input.blob, {
        onProgress: (sent, bps) => emit("uploading", sent, bps, activeSession),
        signal,
      }).then(async (sizeBytes) => {
        emit("finalizing", sizeBytes, 0, activeSession);
        const result = await finalize(activeSession, signal);
        emit("done", sizeBytes, 0, activeSession);
        await deleteSession(activeSession.recordingId);
        return result;
      });
    } catch (error) {
      if (error instanceof StaleUploadError && !restarted) {
        restarted = true;
        await reinit(activeSession, signal);
        continue;
      }
      if (error instanceof CapExceededError) {
        if (!refreshedForCap) {
          // Re-upload every part once so the server can finalise from ETags
          // while the provider's read/listing quota is exhausted.
          refreshedForCap = true;
          activeSession.completedParts = [];
          activeSession.partEtags = {};
          await saveSession(activeSession);
          continue;
        }
        throw new UploadFailed(
          "The storage provider's daily transaction cap is exhausted. Raise the cap (Backblaze → Caps & Alerts) or retry after 00:00 GMT — your recording is still saved locally.",
          true,
        );
      }
      throw error;
    }
  }
}

function placeholderMeta(input: UploadInput, mimeType: string): UploadSessionMeta {
  return {
    recordingId: "new",
    title: input.title,
    mimeType,
    sizeBytes: input.blob.size,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    chunkSizeBytes: 0,
    partCount: 1,
    completedParts: [],
    partEtags: {},
    thumbnailUploaded: false,
    hasBlob: false,
    createdAt: new Date().toISOString(),
  };
}

function sizeOfCompleted(session: UploadSessionMeta): number {
  return session.completedParts.reduce(
    (sum, part) => sum + partSize(part, session.sizeBytes, session.chunkSizeBytes),
    0,
  );
}

async function uploadParts(
  session: UploadSessionMeta,
  blob: Blob,
  opts: {
    onProgress: (sentBytes: number, bytesPerSecond: number) => void;
    signal?: AbortSignal;
  },
): Promise<number> {
  const { signal } = opts;
  const pending: number[] = [];
  for (let part = 1; part <= session.partCount; part++) {
    if (!session.completedParts.includes(part)) pending.push(part);
  }

  let sent = sizeOfCompleted(session);
  let bps = 0;
  let lastTick = performance.now();
  let lastEmit = 0;
  const signedUrls = new Map<number, string>();

  const ensureSigned = async (parts: number[], reqSignal: AbortSignal) => {
    const missing = parts.filter((p) => !signedUrls.has(p)).slice(0, 50);
    if (missing.length === 0) return;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (reqSignal.aborted) throw new UploadAborted();
      try {
        const res = await api<{ parts: { partNumber: number; url: string }[] }>(
          `/api/uploads/${session.recordingId}/parts`,
          { body: { partNumbers: missing }, signal: reqSignal },
        );
        for (const part of res.parts) signedUrls.set(part.partNumber, part.url);
        return;
      } catch (error) {
        if (error instanceof UploadAborted) throw error;
        if (error instanceof ApiHttpError && error.status === 404) {
          throw new UploadFailed(
            "This recording no longer exists on the server (it may have been discarded).",
            false,
          );
        }
        if (error instanceof ApiHttpError && error.status === 409) {
          throw new UploadFailed(error.message, false);
        }
        lastError = error;
        await sleep(500 * attempt, reqSignal);
      }
    }
    throw new UploadFailed(
      lastError instanceof Error
        ? lastError.message
        : "Failed to sign upload URLs",
      true,
    );
  };

  const queue = [...pending];
  const localAbort = new AbortController();
  const onExternalAbort = () => localAbort.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const localSignal = localAbort.signal;
  let firstError: unknown = null;

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, pending.length || 1) },
    async () => {
      try {
        for (;;) {
          if (localSignal.aborted) throw new UploadAborted();
          const part = queue.shift();
          if (part === undefined) break;

          const window: number[] = [];
          for (
            let p = part;
            p <= Math.min(session.partCount, part + SIGN_AHEAD - 1);
            p++
          ) {
            if (!session.completedParts.includes(p)) window.push(p);
          }
          await ensureSigned(window, localSignal);

          const url = signedUrls.get(part);
          if (!url) {
            throw new UploadFailed(`Missing signed URL for part ${part}`, true);
          }

          const start = (part - 1) * session.chunkSizeBytes;
          const end = Math.min(start + session.chunkSizeBytes, blob.size);
          const chunk = blob.slice(start, end);

          const etag = await putChunk(url, chunk, localSignal);
          signedUrls.delete(part);
          session.completedParts.push(part);
          session.completedParts.sort((a, b) => a - b);
          if (etag) {
            session.partEtags = { ...(session.partEtags ?? {}), [part]: etag };
          }
          await saveSession(session);

          const now = performance.now();
          const bytes = partSize(part, session.sizeBytes, session.chunkSizeBytes);
          sent += bytes;
          const dt = (now - lastTick) / 1000;
          lastTick = now;
          if (dt > 0) {
            const instant = bytes / dt;
            bps = bps === 0 ? instant : bps * 0.6 + instant * 0.4;
          }
          if (
            now - lastEmit > 250 ||
            session.completedParts.length === session.partCount
          ) {
            lastEmit = now;
            opts.onProgress(sent, bps);
          }
        }
      } catch (error) {
        // First failure wins; sibling workers stop through localAbort.
        if (firstError === null) firstError = error;
        if (!localAbort.signal.aborted) localAbort.abort();
      }
    },
  );

  try {
    await Promise.all(workers);
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
  }
  if (firstError !== null) throw firstError;
  opts.onProgress(sent, bps);
  return sent;
}

interface ClientPart {
  partNumber: number;
  etag: string;
}

/** Every part ETag is known only when the whole blob has been uploaded. */
function clientParts(session: UploadSessionMeta): ClientPart[] | undefined {
  if (session.completedParts.length !== session.partCount) return undefined;
  const etags = session.partEtags ?? {};
  const parts: ClientPart[] = [];
  for (let part = 1; part <= session.partCount; part++) {
    const etag = etags[part];
    if (!etag) return undefined;
    parts.push({ partNumber: part, etag });
  }
  return parts;
}

async function finalize(
  session: UploadSessionMeta,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const parts = clientParts(session);
  let lastMessage = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await api<UploadResult>(
        `/api/uploads/${session.recordingId}/complete`,
        {
          body: { sizeBytes: session.sizeBytes, ...(parts ? { parts } : {}) },
          signal,
        },
      );
    } catch (error) {
      if (error instanceof UploadAborted) throw error;
      if (
        error instanceof ApiHttpError &&
        error.status === 503 &&
        /cap/i.test(error.message)
      ) {
        throw new CapExceededError();
      }
      if (error instanceof ApiHttpError && error.status === 410) {
        throw new StaleUploadError();
      }
      if (error instanceof ApiHttpError && error.status === 404) {
        throw new UploadFailed(
          "This recording no longer exists on the server (it may have been discarded).",
          false,
        );
      }
      if (error instanceof ApiHttpError && error.status === 409) {
        lastMessage = error.message;
        if (attempt < 3) {
          await sleep(1200 * attempt, signal);
          continue;
        }
        throw new UploadFailed(`Could not finalise the upload: ${lastMessage}`, true);
      }
      if (error instanceof UploadFailed) throw error;
      lastMessage = error instanceof Error ? error.message : String(error);
      if (attempt === 3) break;
      await sleep(800, signal);
    }
  }
  throw new UploadFailed(`Could not finalise the upload: ${lastMessage}`, true);
}

async function reinit(
  session: UploadSessionMeta,
  signal?: AbortSignal,
): Promise<void> {
  const res = await api<{ chunkSizeBytes: number; partCount: number }>(
    `/api/uploads/${session.recordingId}/reinit`,
    { signal },
  );
  session.chunkSizeBytes = res.chunkSizeBytes;
  session.partCount = res.partCount;
  session.completedParts = [];
  session.partEtags = {};
  await saveSession(session);
}
