import { NextResponse } from "next/server";
import { requireOwner, jsonError, serverErrorMessage } from "@/lib/api";
import { getServerEnv } from "@/lib/env";
import { runStorageCleanup } from "@/lib/storage-cleanup";
import { isLocalMode, localUsage, localRunCleanup } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/** Current storage usage (completed recordings only). */
export async function GET() {
  if (isLocalMode()) return NextResponse.json(await localUsage());
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("recordings")
    .select("size_bytes, status, created_at")
    .eq("status", "completed");

  if (error) return jsonError(500, "db_error", error.message);

  const usedBytes = (data ?? []).reduce(
    (sum, row) => sum + (Number(row.size_bytes) || 0),
    0,
  );

  return NextResponse.json({
    usedBytes,
    limitBytes: getServerEnv().storageLimitBytes,
    completedCount: data?.length ?? 0,
  });
}

/** Runs the quota cleanup now (oldest completed recordings first). */
export async function POST() {
  if (isLocalMode()) return NextResponse.json(await localRunCleanup());
  const auth = await requireOwner();
  if (!auth.ok) return auth.response;

  try {
    const result = await runStorageCleanup(auth.ctx.supabase);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(500, "cleanup_failed", serverErrorMessage(error));
  }
}
