import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  IdParams,
  jsonError,
  notFound,
  parseBody,
  requireOwner,
  serverErrorMessage,
} from "@/lib/api";
import { deleteObjects } from "@/lib/r2";
import { isLocalMode, localDeleteRecording, localGetRecording, localUpdateRecording } from "@/lib/local-store";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    shareEnabled: z.boolean().optional(),
  })
  .refine((value) => value.title !== undefined || value.shareEnabled !== undefined, {
    message: "nothing to update",
  });

/** PATCH: rename and/or toggle the share link. */
export async function PATCH(request: NextRequest, ctx: IdParams) {
  const raw = await request.json().catch(() => null);
  const parsed = parseBody(raw, patchSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body || (body.title === undefined && body.shareEnabled === undefined)) {
    return jsonError(400, "invalid_request", "nothing to update");
  }
  const { id } = await ctx.params;

  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row) return notFound("recording");
    if (body.shareEnabled !== undefined && body.shareEnabled && !row.share_token) {
      return jsonError(400, "share_not_created", "Create the share link first.");
    }
    const updated = await localUpdateRecording(id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.shareEnabled !== undefined ? { share_enabled: body.shareEnabled } : {}),
    });
    return NextResponse.json({ recording: updated });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error: fetchError } = await supabase
    .from("recordings")
    .select("id, share_token")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return jsonError(500, "db_error", fetchError.message);
  if (!row) return notFound("recording");

  const update: Record<string, unknown> = {};
  if (body.title !== undefined) update.title = body.title;
  if (body.shareEnabled !== undefined) {
    if (body.shareEnabled && !row.share_token) {
      return jsonError(400, "share_not_created", "Create the share link first.");
    }
    update.share_enabled = body.shareEnabled;
  }

  const { data: updated, error } = await supabase
    .from("recordings")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return jsonError(500, "db_error", error.message);

  return NextResponse.json({ recording: updated });
}

/**
 * DELETE: removes the video from R2 first, then the database row.
 * If object deletion fails the row is kept so storage accounting stays
 * accurate — nothing is ever "half deleted".
 */
export async function DELETE(_request: NextRequest, ctx: IdParams) {
  const { id } = await ctx.params;
  if (isLocalMode()) {
    const deleted = await localDeleteRecording(id);
    return deleted ? NextResponse.json({ ok: true }) : notFound("recording");
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error: fetchError } = await supabase
    .from("recordings")
    .select("id, r2_key, thumbnail_key, status")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return jsonError(500, "db_error", fetchError.message);
  if (!row) return notFound("recording");

  try {
    const keys = row.thumbnail_key
      ? [row.r2_key, row.thumbnail_key]
      : [row.r2_key];
    const failed = await deleteObjects(keys);
    if (failed.length > 0) {
      return jsonError(502, "storage_delete_failed", failed.join(", "));
    }
  } catch (error) {
    return jsonError(502, "storage_delete_failed", serverErrorMessage(error));
  }

  const { error: deleteError } = await supabase
    .from("recordings")
    .delete()
    .eq("id", row.id);
  if (deleteError) return jsonError(500, "db_error", deleteError.message);

  return NextResponse.json({ ok: true });
}
