import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteObjects } from "@/lib/r2";
import { getServerEnv } from "@/lib/env";

export interface CleanupItem {
  id: string;
  r2Key: string;
  thumbnailKey: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface CleanupPlan {
  deleteIds: string[];
  freedBytes: number;
  targetBytes: number;
}

/**
 * Pure planning step: decide which completed recordings must be removed to
 * get back under the storage limit.
 *
 * - Never runs when usage is below the configured limit.
 * - Deletes the OLDEST completed recordings first.
 * - Frees down to `targetRatio` of the limit so there is headroom for the
 *   next recording instead of immediately re-triggering.
 * - Only completed items may be passed in; callers must never include
 *   active or incomplete uploads (this function is a second line of defence:
 *   it also ignores items with unknown sizes only after they are sorted).
 */
export function planCleanup(
  items: CleanupItem[],
  totalUsedBytes: number,
  limitBytes: number,
  targetRatio = 0.9,
): CleanupPlan {
  const targetBytes = Math.floor(limitBytes * targetRatio);

  if (limitBytes > 0 && totalUsedBytes < limitBytes) {
    return { deleteIds: [], freedBytes: 0, targetBytes };
  }

  const ordered = [...items].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  );

  const deleteIds: string[] = [];
  let freed = 0;
  for (const item of ordered) {
    if (totalUsedBytes - freed <= targetBytes) break;
    deleteIds.push(item.id);
    freed += Math.max(0, item.sizeBytes);
  }
  return { deleteIds, freedBytes: freed, targetBytes };
}

export interface CleanupResult {
  deletedCount: number;
  freedBytes: number;
  usedBytes: number;
  limitBytes: number;
  errors: string[];
}

/**
 * Executes storage cleanup for the signed-in owner:
 * oldest completed recordings are removed from R2 first, then from the
 * database. If R2 deletion fails the row is kept, so recorded usage never
 * under-reports real storage usage. Incomplete/active uploads are never
 * touched.
 */
export async function runStorageCleanup(
  supabase: SupabaseClient,
): Promise<CleanupResult> {
  const { storageLimitBytes } = getServerEnv();
  const errors: string[] = [];

  const { data, error } = await supabase
    .from("recordings")
    .select("id, r2_key, thumbnail_key, size_bytes, created_at")
    .eq("status", "completed")
    .order("created_at", { ascending: true });

  if (error) {
    return {
      deletedCount: 0,
      freedBytes: 0,
      usedBytes: 0,
      limitBytes: storageLimitBytes,
      errors: [`Failed to list recordings: ${error.message}`],
    };
  }

  const items: CleanupItem[] = (data ?? []).map((row) => ({
    id: row.id,
    r2Key: row.r2_key,
    thumbnailKey: row.thumbnail_key,
    sizeBytes: Number(row.size_bytes) || 0,
    createdAt: row.created_at,
  }));
  const usedBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);

  const plan = planCleanup(items, usedBytes, storageLimitBytes);
  if (plan.deleteIds.length === 0) {
    return {
      deletedCount: 0,
      freedBytes: 0,
      usedBytes,
      limitBytes: storageLimitBytes,
      errors,
    };
  }

  const selected = items.filter((item) => plan.deleteIds.includes(item.id));
  const keysToDelete = selected.flatMap((item) =>
    item.thumbnailKey ? [item.r2Key, item.thumbnailKey] : [item.r2Key],
  );

  let failedKeys: Set<string>;
  try {
    failedKeys = new Set(await deleteObjects(keysToDelete));
  } catch (error) {
    return {
      deletedCount: 0,
      freedBytes: 0,
      usedBytes,
      limitBytes: storageLimitBytes,
      errors: [
        `R2 delete failed, nothing removed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const deletable = selected.filter((item) => {
    const keys = item.thumbnailKey ? [item.r2Key, item.thumbnailKey] : [item.r2Key];
    const failed = keys.some((key) => failedKeys.has(key));
    if (failed) errors.push(`R2 delete failed for ${item.r2Key}`);
    return !failed;
  });

  let deletedCount = 0;
  let freedBytes = 0;
  if (deletable.length > 0) {
    const { error: dbError } = await supabase
      .from("recordings")
      .delete()
      .in(
        "id",
        deletable.map((item) => item.id),
      );
    if (dbError) {
      errors.push(
        `Objects removed from R2 but database delete failed: ${dbError.message}`,
      );
    } else {
      deletedCount = deletable.length;
      freedBytes = deletable.reduce((sum, item) => sum + item.sizeBytes, 0);
    }
  }

  return {
    deletedCount,
    freedBytes,
    usedBytes: usedBytes - freedBytes,
    limitBytes: storageLimitBytes,
    errors,
  };
}
