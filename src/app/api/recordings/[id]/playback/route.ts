import { NextResponse, type NextRequest } from "next/server";
import { IdParams, jsonError, notFound, requireOwner } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { presignGet } from "@/lib/r2";
import { isLocalMode, localFileUrl, localGetRecording } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Returns a short-lived playback (or download) link for a private recording.
 * The bucket itself stays private — only this presigned URL can fetch bytes.
 */
export async function GET(request: NextRequest, ctx: IdParams) {
  const { id } = await ctx.params;
  const download = request.nextUrl.searchParams.get("dl") === "1";
  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row) return notFound("recording");
    if (row.status !== "completed") return jsonError(409, "not_ready", `status is ${row.status}`);
    return NextResponse.json({ url: `${localFileUrl(id, "video")}${download ? "?dl=1" : ""}`, expiresIn: 0 });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, title, status, r2_key, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status !== "completed") {
    return jsonError(409, "not_ready", `status is ${row.status}`);
  }

  try {
    const url = await presignGet(row.r2_key, {
      expiresIn: getServerEnv().presignTtlSeconds,
      ...(download
        ? { downloadFilename: `${row.title || "recording"}.${extension(row)}` }
        : {}),
    });
    return NextResponse.json({
      url,
      expiresIn: getServerEnv().presignTtlSeconds,
    });
  } catch (error) {
    return jsonError(502, "r2_sign_failed", error instanceof Error ? error.message : String(error));
  }
}

function extension(row: { mime_type: string | null }): string {
  const mime = row.mime_type ?? "";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("matroska")) return "mkv";
  return "webm";
}
