import { NextResponse, type NextRequest } from "next/server";
import { jsonError, notFound, requireOwner, serverErrorMessage, IdParams } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { presignPut } from "@/lib/r2";

export const dynamic = "force-dynamic";

/**
 * Returns a presigned PUT URL for the recording's thumbnail (small JPEG).
 * Failures here are non-fatal — the UI falls back to a placeholder.
 */
export async function POST(
  _request: NextRequest,
  ctx: IdParams,
) {
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const { supabase } = auth.ctx;

  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, thumbnail_key, status")
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status !== "uploading") {
    return jsonError(409, "not_accepting_uploads");
  }
  if (!row.thumbnail_key) return jsonError(409, "no_thumbnail_key");

  try {
    const url = await presignPut(
      row.thumbnail_key,
      getServerEnv().presignTtlSeconds,
    );
    return NextResponse.json({ url });
  } catch (error) {
    return jsonError(502, "r2_sign_failed", serverErrorMessage(error));
  }
}
