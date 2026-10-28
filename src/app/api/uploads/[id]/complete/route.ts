import { NextResponse, type NextRequest } from "next/server";
import { jsonError, notFound, requireOwner, serverErrorMessage, IdParams } from "@/lib/api";
import {
  completeMultipartUpload,
  isNoSuchUpload,
  listParts,
} from "@/lib/r2";
import { runStorageCleanup } from "@/lib/storage-cleanup";
import { isLocalMode, localCompleteUpload, localGetRecording, localUsage, localChunkSizeBytes, localRunCleanup } from "@/lib/local-store";
import type { CompleteUploadResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

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
    const parts = await listParts(row.r2_key, row.upload_id);
    if (parts.length === 0) {
      return jsonError(409, "no_uploaded_parts");
    }

    const totalSize = parts.reduce((sum, part) => sum + part.size, 0);
    const expected = Number(row.size_bytes) || 0;
    if (expected > 0 && totalSize !== expected) {
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
