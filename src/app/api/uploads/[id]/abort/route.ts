import { NextResponse, type NextRequest } from "next/server";
import { jsonError, notFound, requireOwner, serverErrorMessage, IdParams } from "@/lib/api";
import { abortMultipartUpload, deleteObjects } from "@/lib/r2";
import { isLocalMode, localAbortUpload } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Explicit user action: aborts a pending upload and removes its row.
 * This is the ONLY way incomplete uploads are removed — automatic cleanup
 * never touches them.
 */
export async function POST(
  _request: NextRequest,
  ctx: IdParams,
) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    await localAbortUpload(id);
    return NextResponse.json({ ok: true });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, r2_key, thumbnail_key, upload_id, status")
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status === "completed") {
    return jsonError(409, "already_completed", "Use delete instead.");
  }

  try {
    if (row.upload_id) {
      await abortMultipartUpload(row.r2_key, row.upload_id);
    }
    if (row.thumbnail_key) {
      await deleteObjects([row.thumbnail_key]);
    }
  } catch (error) {
    return jsonError(502, "r2_abort_failed", serverErrorMessage(error));
  }

  const { error: deleteError } = await supabase
    .from("recordings")
    .delete()
    .eq("id", row.id);
  if (deleteError) return jsonError(500, "db_error", deleteError.message);

  return NextResponse.json({ ok: true });
}
