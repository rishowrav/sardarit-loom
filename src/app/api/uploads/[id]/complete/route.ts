import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, notFound, parseBody, requireOwner, serverErrorMessage, IdParams } from "@/lib/api";
import {
  completeMultipartUpload,
  isCapExceeded,
  isNoSuchUpload,
  listParts,
  partCount,
  type ListedPart,
} from "@/lib/r2";
import { getServerEnv } from "@/lib/env";
import { runStorageCleanup } from "@/lib/storage-cleanup";
import { isLocalMode, localCompleteUpload, localGetRecording, localUsage, localChunkSizeBytes, localRunCleanup } from "@/lib/local-store";
import type { CompleteUploadResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Optional client-supplied part list. Only used when the storage provider's
 * read/listing quota is exhausted (e.g. Backblaze B2 daily transaction cap):
 * writes are still allowed, so the multipart upload can be completed without
 * a ListParts round-trip.
 */
const completeSchema = z.object({
  sizeBytes: z.number().int().min(0).optional(),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(100_000),
        etag: z.string().trim().min(1).max(200),
      }),
    )
    .max(10_000)
    .optional(),
});

/**
 * Finalises a chunked upload:
 * 1. asks R2 which parts actually landed (self-healing for retries),
 * 2. verifies the byte total matches what the client reported,
 * 3. completes the multipart upload and marks the row completed,
 * 4. runs automatic storage cleanup against the configured limit.
 */
export async function POST(
  request: NextRequest,
  ctx: IdParams,
) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row) return notFound("recording");
    if (row.status === "completed") return jsonError(409, "already_completed");
    try {
      const sizeBytes = await localCompleteUpload(id, Math.ceil(row.size_bytes / localChunkSizeBytes()));
      const cleanupResult = await localRunCleanup();
      const storage = await localUsage();
      const response: CompleteUploadResponse = {
        recordingId: id,
        sizeBytes,
        storage,
        cleanup: { deletedCount: cleanupResult.deletedCount, freedBytes: cleanupResult.freedBytes, errors: cleanupResult.errors },
      };
      return NextResponse.json(response);
    } catch (error) {
      return jsonError(400, "local_complete_failed", serverErrorMessage(error));
    }
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const parsed = parseBody(
    await request.json().catch(() => ({})),
    completeSchema,
  );
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { supabase } = auth.ctx;

  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, r2_key, upload_id, status, size_bytes")
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status === "completed") {
    return jsonError(409, "already_completed");
  }
  if (row.status !== "uploading" || !row.upload_id) {
    return jsonError(409, "upload_not_initialized");
  }

  try {
    const expected = Number(row.size_bytes) || 0;
    let listed: ListedPart[] | null = null;
    try {
      listed = await listParts(row.r2_key, row.upload_id);
    } catch (listError) {
      // Backblaze B2 caps reads/listing per day but still allows writes. When
      // the cap is hit, finalise with the parts the client uploaded so the
      // recording is not lost; S3 still rejects missing/out-of-order parts.
      if (!isCapExceeded(listError) || !body.parts?.length) throw listError;

      const expectedParts = partCount(expected, getServerEnv().chunkSizeBytes);
      const supplied = [...body.parts].sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      const complete =
        expected > 0 &&
        supplied.length === expectedParts &&
        supplied.every((part, index) => part.partNumber === index + 1);
      if (!complete) {
        return jsonError(
          409,
          "parts_incomplete",
          "Storage listing is unavailable (transaction cap) and the supplied part list is incomplete — resume the upload.",
        );
      }
      listed = supplied.map((part) => ({
        partNumber: part.partNumber,
        size: 0,
        etag: part.etag,
      }));
    }

    if (listed === null || listed.length === 0) {
      return jsonError(409, "no_uploaded_parts");
    }

    const parts = listed;
    const verified = parts.some((part) => part.size > 0);
    const totalSize = verified
      ? parts.reduce((sum, part) => sum + part.size, 0)
      : expected;
    if (verified && expected > 0 && totalSize !== expected) {
      return NextResponse.json(
        {
          error: "size_mismatch",
          expected,
          actual: totalSize,
          hint: "Some chunks are missing — resume the upload.",
        },
        { status: 409 },
      );
    }

    await completeMultipartUpload(row.r2_key, row.upload_id, parts);

    const { error: updateError } = await supabase
      .from("recordings")
      .update({ status: "completed", size_bytes: totalSize, upload_id: null })
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);

    // Automatic quota cleanup — failures must never lose the new recording.
    let cleanup: CompleteUploadResponse["cleanup"] = {
      deletedCount: 0,
      freedBytes: 0,
      errors: [],
    };
    let storage: CompleteUploadResponse["storage"] = {
      usedBytes: 0,
      limitBytes: 0,
      completedCount: 0,
    };
    try {
      const result = await runStorageCleanup(supabase);
      cleanup = {
        deletedCount: result.deletedCount,
        freedBytes: result.freedBytes,
        errors: result.errors,
      };
      storage = {
        usedBytes: result.usedBytes,
        limitBytes: result.limitBytes,
        completedCount: 0,
      };
    } catch (cleanupError) {
      cleanup.errors = [serverErrorMessage(cleanupError)];
    }

    const response: CompleteUploadResponse = {
      recordingId: row.id,
      sizeBytes: totalSize,
      storage,
      cleanup,
    };
    return NextResponse.json(response);
  } catch (error) {
    if (isCapExceeded(error)) {
      return jsonError(
        503,
        "storage_cap_exceeded",
        "The storage provider's daily transaction cap is exhausted. Raise the cap in Backblaze (Caps & Alerts) or retry after 00:00 GMT.",
      );
    }
    if (isNoSuchUpload(error)) {
      // R2 no longer knows this multipart upload (expired/aborted).
      return jsonError(
        410,
        "upload_expired",
        "The upload session no longer exists on R2 — restart the upload.",
      );
    }
    return jsonError(502, "r2_complete_failed", serverErrorMessage(error));
  }
}
