import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, notFound, parseBody, requireOwner, serverErrorMessage, IdParams } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { presignUploadPart } from "@/lib/r2";
import { isLocalMode, localGetRecording } from "@/lib/local-store";
import type { SignPartsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const partsSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1).max(10_000))
    .min(1)
    .max(100),
});

/** Returns presigned URLs for a batch of multipart chunks. */
export async function POST(
  request: NextRequest,
  ctx: IdParams,
) {
  const parsed = parseBody(await request.json().catch(() => null), partsSchema);
  if (!parsed.ok) return parsed.response;
  const { id } = await ctx.params;

  if (isLocalMode()) {
    const row = await localGetRecording(id);
    if (!row || row.status !== "uploading") return notFound("recording");
    return NextResponse.json({
      parts: parsed.data.partNumbers.map((partNumber) => ({
        partNumber,
        url: `/api/local-upload/${id}/${partNumber}`,
      })),
    } satisfies SignPartsResponse);
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { supabase } = auth.ctx;

  const { data: row, error } = await supabase
    .from("recordings")
    .select("id, r2_key, upload_id, status")
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(500, "db_error", error.message);
  if (!row) return notFound("recording");
  if (row.status !== "uploading") {
    return jsonError(409, "not_accepting_uploads", `status is ${row.status}`);
  }
  if (!row.upload_id) return jsonError(409, "upload_not_initialized");

  const env = getServerEnv();
  try {
    const parts = await Promise.all(
      parsed.data.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await presignUploadPart(
          row.r2_key,
          row.upload_id!,
          partNumber,
          env.presignTtlSeconds,
        ),
      })),
    );
    const response: SignPartsResponse = { parts };
    return NextResponse.json(response);
  } catch (error) {
    return jsonError(502, "r2_sign_failed", serverErrorMessage(error));
  }
}
