import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv } from "@/lib/env";

/**
 * Cloudflare R2 access (S3-compatible). All credentials stay on the server —
 * the browser only ever receives short-lived, presigned URLs generated here.
 */

let client: S3Client | null = null;

function r2(): S3Client {
  if (!client) {
    const env = getServerEnv();
    client = new S3Client({
      region: env.r2.region,
      endpoint: env.r2.endpoint,
      forcePathStyle: env.r2.forcePathStyle,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
      // Retry transient network failures a couple of times before failing.
      maxAttempts: 3,
    });
  }
  return client;
}

function bucket(): string {
  return getServerEnv().r2.bucket;
}

export function partCount(sizeBytes: number, chunkSizeBytes: number): number {
  if (sizeBytes <= 0) return 1;
  return Math.ceil(sizeBytes / chunkSizeBytes);
}

export async function createMultipartUpload(
  key: string,
  contentType: string,
): Promise<string> {
  const result = await r2().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType,
    }),
  );
  if (!result.UploadId) throw new Error("R2 did not return an upload id");
  return result.UploadId;
}

/**
 * Presigned URL for a single multipart chunk. The client must send the body
 * as-is (no extra signed headers), and R2 requires >= 5 MB parts except the
 * final one.
 */
export async function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    r2(),
    new UploadPartCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn },
  );
}

export interface ListedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export async function listParts(
  key: string,
  uploadId: string,
): Promise<ListedPart[]> {
  const parts: ListedPart[] = [];
  let marker: string | undefined;
  do {
    const result = await r2().send(
      new ListPartsCommand({
        Bucket: bucket(),
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const part of result.Parts ?? []) {
      if (part.PartNumber != null && part.Size != null) {
        parts.push({
          partNumber: part.PartNumber,
          size: part.Size,
          etag: part.ETag ?? "",
        });
      }
    }
    marker = result.NextPartNumberMarker;
  } while (marker);
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: ListedPart[],
): Promise<void> {
  await r2().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
      },
    }),
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
): Promise<void> {
  try {
    await r2().send(
      new AbortMultipartUploadCommand({
        Bucket: bucket(),
        Key: key,
        UploadId: uploadId,
      }),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Idempotent: deleting a missing key is treated as success (S3 semantics). */
export async function deleteObjects(keys: string[]): Promise<string[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  const failed: string[] = [];
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      const result = await r2().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      for (const error of result.Errors ?? []) {
        if (error.Key) failed.push(error.Key);
      }
    } catch {
      // Some S3-compatible stores are picky about batch delete — retry each
      // key individually; missing objects still count as success.
      for (const key of batch) {
        try {
          await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
        } catch (error) {
          if (!isNotFound(error)) failed.push(key);
        }
      }
    }
  }
  return failed;
}

export interface PresignGetOptions {
  expiresIn: number;
  /** When set, the link downloads the file instead of playing inline. */
  downloadFilename?: string;
}

export async function presignGet(
  key: string,
  options: PresignGetOptions,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ...(options.downloadFilename
      ? {
          ResponseContentDisposition: `attachment; filename="${sanitizeFilename(options.downloadFilename)}"`,
        }
      : {}),
  });
  return getSignedUrl(r2(), command, { expiresIn: options.expiresIn });
}

/** Presigned PUT for small sidecar objects (thumbnails). */
export async function presignPut(
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn },
  );
}

export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NotFound" ||
    e.name === "NoSuchKey" ||
    e.name === "NoSuchUpload" ||
    e.$metadata?.httpStatusCode === 404
  );
}

export function isNoSuchUpload(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchUpload" || e.$metadata?.httpStatusCode === 404;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/["\r\n\\]/g, "_").trim() || "recording";
  return cleaned.slice(0, 180);
}

/** Exposed for tests / diagnostics. */
export type { _Object };
