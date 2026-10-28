import { NextResponse } from "next/server";
import { IdParams, jsonError, notFound, requireOwner } from "@/lib/api";
import { createShareToken } from "@/lib/share";
import { isLocalMode, localGetRecording, localUpdateRecording } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Creates (or re-enables) the public share link for a completed recording.
 * The token is long and random; anyone holding the link can watch, nobody
 * else can even discover that the video exists.
 */
export async function POST(_request: Request, ctx: IdParams) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row) return notFound("recording");
    if (row.status !== "completed") return jsonError(409, "not_ready", "Only completed recordings can be shared.");
    const token = row.share_token ?? createShareToken();
    await localUpdateRecording(id, { share_token: token, share_enabled: true });
    return NextResponse.json({ token, enabled: true });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error: fetchError } = await supabase
    .from("recordings")
    .select("id, status, share_token")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return jsonError(500, "db_error", fetchError.message);
  if (!row) return notFound("recording");
  if (row.status !== "completed") {
    return jsonError(409, "not_ready", "Only completed recordings can be shared.");
  }

  const token = row.share_token ?? createShareToken();
  const { data: updated, error } = await supabase
    .from("recordings")
    .update({ share_token: token, share_enabled: true })
    .eq("id", row.id)
    .select("share_token, share_enabled")
    .single();
  if (error) return jsonError(500, "db_error", error.message);

  return NextResponse.json({ token: updated.share_token, enabled: true });
}

/**
 * Revokes the link entirely (token is destroyed; a later "create" generates a
 * brand-new URL so old shares stay dead forever).
 */
export async function DELETE(_request: Request, ctx: IdParams) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    const row = await localUpdateRecording(id, { share_token: null, share_enabled: false });
    return row ? NextResponse.json({ ok: true }) : notFound("recording");
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data, error } = await supabase
    .from("recordings")
    .update({ share_token: null, share_enabled: false })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return jsonError(500, "db_error", error.message);
  if (!data) return notFound("recording");

  return NextResponse.json({ ok: true });
}
