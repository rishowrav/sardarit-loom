import { NextResponse } from "next/server";
import { IdParams, jsonError, notFound, requireOwner, serverErrorMessage } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { createMultipartUpload, partCount, abortMultipartUpload } from "@/lib/r2";
import { isLocalMode, localChunkSizeBytes, localGetRecording } from "@/lib/local-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: IdParams) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row || row.status !== "uploading") return notFound("recording");
    const chunkSizeBytes = localChunkSizeBytes();
    return NextResponse.json({ chunkSizeBytes, partCount: partCount(row.size_bytes, chunkSizeBytes) });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;
  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, r2_key, upload_id, status, size_bytes, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status !== "uploading") return jsonError(409, "not_accepting_uploads", `status is ${row.status}`);

  try {
    if (row.upload_id) await abortMultipartUpload(row.r2_key, row.upload_id);
    const uploadId = await createMultipartUpload(row.r2_key, row.mime_type || "video/webm");
    const { error: updateError } = await supabase.from("recordings").update({ upload_id: uploadId }).eq("id", row.id);
    if (updateError) throw new Error(updateError.message);
    const env = getServerEnv();
    return NextResponse.json({ chunkSizeBytes: env.chunkSizeBytes, partCount: partCount(Number(row.size_bytes) || 1, env.chunkSizeBytes) });
  } catch (error) {
    return jsonError(502, "r2_reinit_failed", serverErrorMessage(error));
  }
}
