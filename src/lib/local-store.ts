import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Recording } from "@/lib/types";

const ROOT = path.join(process.cwd(), "data", "local");
const VIDEO_DIR = path.join(ROOT, "videos");
const PART_DIR = path.join(ROOT, "parts");
const THUMB_DIR = path.join(ROOT, "thumbnails");
const DB_FILE = path.join(ROOT, "recordings.json");

export function isLocalMode(): boolean {
  return process.env.NODE_ENV === "development" && process.env.LOCAL_DEMO_MODE === "true";
}

export function localChunkSizeBytes(): number {
  const mb = Number.parseInt(process.env.CHUNK_SIZE_MB ?? "8", 10);
  return (Number.isFinite(mb) && mb >= 5 ? mb : 8) * 1024 ** 2;
}

export function localStorageLimitBytes(): number {
  const gb = Number.parseInt(process.env.STORAGE_LIMIT_GB ?? "20", 10);
  return (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
}

async function ensureDirs() {
  await Promise.all([mkdir(VIDEO_DIR, { recursive: true }), mkdir(PART_DIR, { recursive: true }), mkdir(THUMB_DIR, { recursive: true })]);
}

async function readAll(): Promise<Recording[]> {
  await ensureDirs();
  try {
    return JSON.parse(await readFile(DB_FILE, "utf8")) as Recording[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeAll(rows: Recording[]) {
  await ensureDirs();
  const temp = `${DB_FILE}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(rows, null, 2), "utf8");
  await rename(temp, DB_FILE);
}

export async function localListRecordings(): Promise<Recording[]> {
  return (await readAll()).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function localGetRecording(id: string): Promise<Recording | null> {
  return (await readAll()).find((row) => row.id === id) ?? null;
}

export async function localCreateRecording(input: {
  title?: string;
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
}): Promise<Recording> {
  const rows = await readAll();
  const now = new Date().toISOString();
  const id = randomUUID();
  const ext = input.mimeType.includes("mp4") ? "mp4" : input.mimeType.includes("matroska") ? "mkv" : "webm";
  const row: Recording = {
    id,
    owner_id: "local",
    title: input.title?.trim() || defaultTitle(),
    status: "uploading",
    share_token: null,
    share_enabled: false,
    size_bytes: input.sizeBytes,
    duration_seconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    mime_type: input.mimeType,
    r2_key: `${id}.${ext}`,
    thumbnail_key: `${id}.jpg`,
    upload_id: "local",
    error_message: null,
    created_at: now,
    updated_at: now,
  };
  rows.push(row);
  await writeAll(rows);
  return row;
}

export async function localUpdateRecording(id: string, patch: Partial<Recording>): Promise<Recording | null> {
  const rows = await readAll();
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  rows[index] = { ...rows[index], ...patch, updated_at: new Date().toISOString() };
  await writeAll(rows);
  return rows[index];
}

function safeId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

export async function localStorePart(id: string, partNumber: number, bytes: Uint8Array): Promise<void> {
  if (!safeId(id) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("invalid part");
  const row = await localGetRecording(id);
  const chunkSize = localChunkSizeBytes();
  const expectedBytes = row ? Math.min(chunkSize, row.size_bytes - (partNumber - 1) * chunkSize) : 0;
  if (!row || row.status !== "uploading" || expectedBytes <= 0 || bytes.byteLength !== expectedBytes) throw new Error("invalid chunk size or upload state");
  await ensureDirs();
  await writeFile(path.join(PART_DIR, `${id}-${partNumber}.part`), bytes);
}

export async function localCompleteUpload(id: string, partCount: number): Promise<number> {
  if (!safeId(id) || !Number.isInteger(partCount) || partCount < 1 || partCount > 10000) throw new Error("invalid upload");
  const row = await localGetRecording(id);
  if (!row || row.status !== "uploading") throw new Error("recording not found or not uploading");
  const destination = path.join(VIDEO_DIR, row.r2_key);
  await rm(destination, { force: true });
  let size = 0;
  for (let part = 1; part <= partCount; part++) {
    const bytes = await readFile(path.join(PART_DIR, `${id}-${part}.part`));
    size += bytes.byteLength;
    await appendFile(destination, bytes);
  }
  if (size !== row.size_bytes) {
    await rm(destination, { force: true });
    throw new Error(`size mismatch: expected ${row.size_bytes}, got ${size}`);
  }
  for (let part = 1; part <= partCount; part++) {
    await rm(path.join(PART_DIR, `${id}-${part}.part`), { force: true });
  }
  await localUpdateRecording(id, { status: "completed", upload_id: null });
  return size;
}

export async function localAbortUpload(id: string): Promise<void> {
  if (!safeId(id)) return;
  for (const name of await readdir(PART_DIR).catch(() => [])) {
    if (name.startsWith(`${id}-`) && name.endsWith(".part")) await rm(path.join(PART_DIR, name), { force: true });
  }
  const row = await localGetRecording(id);
  if (row?.thumbnail_key) await rm(path.join(THUMB_DIR, row.thumbnail_key), { force: true });
  const rows = await readAll();
  await writeAll(rows.filter((item) => item.id !== id));
}

export async function localDeleteRecording(id: string): Promise<boolean> {
  const row = await localGetRecording(id);
  if (!row) return false;
  await Promise.all([
    rm(path.join(VIDEO_DIR, row.r2_key), { force: true }),
    row.thumbnail_key ? rm(path.join(THUMB_DIR, row.thumbnail_key), { force: true }) : Promise.resolve(),
  ]);
  const rows = await readAll();
  await writeAll(rows.filter((item) => item.id !== id));
  return true;
}

export async function localSaveThumbnail(id: string, bytes: Uint8Array): Promise<boolean> {
  const row = await localGetRecording(id);
  if (!row || !row.thumbnail_key) return false;
  await ensureDirs();
  await writeFile(path.join(THUMB_DIR, row.thumbnail_key), bytes);
  return true;
}

export async function localThumbnailPath(id: string): Promise<string | null> {
  const row = await localGetRecording(id);
  if (!row?.thumbnail_key) return null;
  return path.join(THUMB_DIR, row.thumbnail_key);
}

export async function localMediaPath(id: string, kind: "video" | "thumbnail"): Promise<{ path: string; mimeType: string; filename: string } | null> {
  const row = await localGetRecording(id);
  if (!row || row.status !== "completed") return null;
  const filename = kind === "video" ? row.r2_key : row.thumbnail_key;
  if (!filename) return null;
  return {
    path: path.join(kind === "video" ? VIDEO_DIR : THUMB_DIR, filename),
    mimeType: kind === "video" ? row.mime_type ?? "video/webm" : "image/jpeg",
    filename,
  };
}

export async function localRunCleanup() {
  const rows = await localListRecordings();
  const completed = rows.filter((row) => row.status === "completed");
  const usedBytes = completed.reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0);
  const limitBytes = localStorageLimitBytes();
  if (usedBytes < limitBytes) return { deletedCount: 0, freedBytes: 0, usedBytes, limitBytes, errors: [] as string[] };
  let remaining = usedBytes;
  let freedBytes = 0;
  let deletedCount = 0;
  for (const row of [...completed].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (remaining <= Math.floor(limitBytes * 0.9)) break;
    if (await localDeleteRecording(row.id)) {
      remaining -= Number(row.size_bytes) || 0;
      freedBytes += Number(row.size_bytes) || 0;
      deletedCount++;
    }
  }
  return { deletedCount, freedBytes, usedBytes: remaining, limitBytes, errors: [] as string[] };
}

export async function localUsage() {
  const rows = await localListRecordings();
  const completed = rows.filter((row) => row.status === "completed");
  return {
    usedBytes: completed.reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0),
    limitBytes: localStorageLimitBytes(),
    completedCount: completed.length,
  };
}

export async function localFindShared(token: string): Promise<Recording | null> {
  const row = (await readAll()).find((item) => item.share_token === token && item.share_enabled && item.status === "completed");
  return row ?? null;
}

export function localFileUrl(id: string, kind: "video" | "thumbnail"): string {
  return `/api/local-media/${id}/${kind}`;
}

function defaultTitle() {
  const stamp = new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `Recording — ${stamp}`;
}
