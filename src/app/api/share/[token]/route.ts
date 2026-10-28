import { NextResponse, type NextRequest } from "next/server";
import { jsonError, notFound, serverErrorMessage } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { presignGet } from "@/lib/r2";
import { createSupabaseServer } from "@/lib/supabase/server";
import { isLocalMode, localFileUrl, localFindShared } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Public (unauthenticated): returns a fresh temporary playback URL for an
 * enabled share token. Used by the player to rotate expired links.
 */
export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!isValidToken(token)) return notFound("recording");
  if (isLocalMode()) {
    const row = await localFindShared(token);
    if (!row) return notFound("recording");
    return NextResponse.json({ url: localFileUrl(row.id, "video"), expiresIn: 0 });
  }

  try {
    const supabase = await createSupabaseServer();
    const { data, error } = await supabase.rpc("get_shared_recording", {
      p_token: token,
    });
    if (error) return jsonError(500, "db_error", error.message);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return notFound("recording");

    const url = await presignGet(row.r2_key as string, {
      expiresIn: getServerEnv().presignTtlSeconds,
    });
    return NextResponse.json({
      url,
      expiresIn: getServerEnv().presignTtlSeconds,
    });
  } catch (error) {
    return jsonError(502, "r2_sign_failed", serverErrorMessage(error));
  }
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(token);
}
