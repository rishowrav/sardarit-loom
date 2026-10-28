import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, parseBody, requireOwner, serverErrorMessage } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { isLocalMode, localCreateRecording, localChunkSizeBytes } from "@/lib/local-store";
import { createMultipartUpload, partCount } from "@/lib/r2";
import type { InitiateUploadResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const initiateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  durationSeconds: z.number().int().min(0).max(604_800), // 7d sanity bound, not a limit
  width: z.number().int().min(1).max(7680),
  height: z.number().int().min(1).max(7680),
  sizeBytes: z.number().int().min(1).max(1_099_511_627_776), // 1 TB sanity bound
  mimeType: z
    .string()
    .trim()
    .max(100)
    // MediaRecorder may report "video/webm;codecs=vp9,opus" — store the
    // container only ("video/webm") so validation and keys stay predictable.
    .transform((value) => value.split(";")[0].trim().toLowerCase())
    .refine((value) => /^video\/[a-z0-9.+-]+$/.test(value), {
      message: "unsupported mime type",
    }),
});

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("matroska")) return "mkv";
  return "webm";
}

/**
 * Step 1 of the chunked upload: creates the database row and an R2 multipart
 * upload, then returns the chunking parameters for the client.
 */
export async function POST(request: NextRequest) {
  const parsed = parseBody(await request.json().catch(() => null), initiateSchema);
  if (!parsed.ok) return parsed.response;

  if (isLocalMode()) {
    const input = parsed.data;
    const row = await localCreateRecording(input);
    const chunkSizeBytes = localChunkSizeBytes();
    return NextResponse.json({
      recordingId: row.id,
      chunkSizeBytes,
      partCount: partCount(input.sizeBytes, chunkSizeBytes),
      local: true,
    }, { status: 201 });
  }

  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const env = getServerEnv();
  const { supabase, user } = auth.ctx;
  const input = parsed.data;

  const key = `recordings/${user.id}/${crypto.randomUUID()}.${extensionFor(input.mimeType)}`;
  const thumbnailKey = `${key}.thumb.jpg`;

  const { data: row, error: insertError } = await supabase
    .from("recordings")
    .insert({
      owner_id: user.id,
      title: input.title ?? defaultTitle(),
      status: "uploading",
      size_bytes: input.sizeBytes,
      duration_seconds: input.durationSeconds,
      width: input.width,
      height: input.height,
      mime_type: input.mimeType,
      r2_key: key,
      thumbnail_key: thumbnailKey,
    })
    .select("id")
    .single();

  if (insertError || !row) {
    return jsonError(500, "db_error", insertError?.message);
  }

  try {
    const uploadId = await createMultipartUpload(key, input.mimeType);
    const { error: updateError } = await supabase
      .from("recordings")
      .update({ upload_id: uploadId })
      .eq("id", row.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    const response: InitiateUploadResponse = {
      recordingId: row.id,
      chunkSizeBytes: env.chunkSizeBytes,
      partCount: partCount(input.sizeBytes, env.chunkSizeBytes),
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    // Roll back the row so a failed initiation never leaves a zombie record.
    await supabase.from("recordings").delete().eq("id", row.id);
    return jsonError(502, "r2_initiate_failed", serverErrorMessage(error));
  }
}

function defaultTitle(): string {
  const now = new Date();
  const stamp = now.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Recording — ${stamp}`;
}
