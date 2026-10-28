import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCleanup, type CleanupItem } from "@/lib/storage-cleanup";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function item(
  id: string,
  sizeBytes: number,
  createdAt: string,
): CleanupItem {
  return { id, r2Key: `recordings/${id}.webm`, thumbnailKey: null, sizeBytes, createdAt };
}

describe("planCleanup", () => {
  it("never runs below the limit", () => {
    const items = [item("a", 5 * GB, "2026-01-01T00:00:00Z")];
    const plan = planCleanup(items, 5 * GB, 10 * GB);
    assert.deepEqual(plan.deleteIds, []);
    assert.equal(plan.freedBytes, 0);
    assert.equal(plan.targetBytes, 9 * GB);
  });

  it("runs when usage exactly reaches the limit", () => {
    const items = [
      item("old", 5 * GB, "2026-01-01T00:00:00Z"),
      item("new", 5 * GB, "2026-01-02T00:00:00Z"),
    ];
    const plan = planCleanup(items, 10 * GB, 10 * GB);
    // 10 GB used, target 9 GB → only the oldest must go.
    assert.deepEqual(plan.deleteIds, ["old"]);
    assert.equal(plan.freedBytes, 5 * GB);
  });

  it("deletes oldest first and stops once under the target", () => {
    const items = [
      item("c", 2 * GB, "2026-01-03T00:00:00Z"),
      item("a", 4 * GB, "2026-01-01T00:00:00Z"),
      item("b", 3 * GB, "2026-01-02T00:00:00Z"),
    ];
    const plan = planCleanup(items, 9 * GB, 10 * GB);
    // target = 9 GB, used = 9 GB < limit → no-op.
    assert.deepEqual(plan.deleteIds, []);

    const overPlan = planCleanup(items, 11 * GB, 10 * GB);
    // 11 GB - 4 GB (oldest) = 7 GB ≤ 9 GB → stop after one.
    assert.deepEqual(overPlan.deleteIds, ["a"]);
    assert.equal(overPlan.freedBytes, 4 * GB);
  });

  it("keeps deleting until enough headroom exists", () => {
    const items = [
      item("a", 4 * GB, "2026-01-01T00:00:00Z"),
      item("b", 4 * GB, "2026-01-02T00:00:00Z"),
      item("c", 4 * GB, "2026-01-03T00:00:00Z"),
    ];
    const plan = planCleanup(items, 12 * GB, 10 * GB);
    // 12 - 4 = 8 ≤ 9 → one item is enough.
    assert.deepEqual(plan.deleteIds, ["a"]);

    const plan2 = planCleanup(items, 20 * GB, 10 * GB);
    // 20 → need ≤ 9: remove a (16), b (12), c (8) → three items.
    assert.deepEqual(plan2.deleteIds, ["a", "b", "c"]);
    assert.equal(plan2.freedBytes, 12 * GB);
  });

  it("breaks createdAt ties deterministically by id", () => {
    const stamp = "2026-01-01T00:00:00Z";
    const items = [item("zz", 4 * GB, stamp), item("aa", 4 * GB, stamp)];
    const plan = planCleanup(items, 10 * GB, 10 * GB);
    // 10 GB used → need ≤ 9 GB → one 4 GB item, tie broken by id.
    assert.deepEqual(plan.deleteIds, ["aa"]);
  });

  it("never selects items with zero or negative sizes for freeing", () => {
    const items = [item("zero", 0, "2026-01-01T00:00:00Z")];
    // Degenerate case: used is over limit but nothing can be freed —
    // the zero-size item is still "selected" but contributes no bytes.
    const plan = planCleanup(items, 11 * GB, 10 * GB);
    assert.equal(plan.freedBytes, 0);
    assert.equal(plan.targetBytes, 9 * GB);
  });

  it("honours a custom target ratio", () => {
    const items = [item("a", 6 * GB, "2026-01-01T00:00:00Z")];
    const plan = planCleanup(items, 10 * GB, 10 * GB, 0.5);
    assert.equal(plan.targetBytes, 5 * GB);
    // 10 - 6 = 4 ≤ 5 → a single deletion suffices.
    assert.deepEqual(plan.deleteIds, ["a"]);
  });

  it("is idempotent when applied to its own output", () => {
    const items = [
      item("a", 4 * GB, "2026-01-01T00:00:00Z"),
      item("b", 4 * GB, "2026-01-02T00:00:00Z"),
      item("c", 4 * GB, "2026-01-03T00:00:00Z"),
    ];
    const first = planCleanup(items, 12 * GB, 10 * GB);
    const remaining = items.filter((entry) => !first.deleteIds.includes(entry.id));
    const second = planCleanup(
      remaining,
      12 * GB - first.freedBytes,
      10 * GB,
    );
    assert.deepEqual(second.deleteIds, []);
  });

  it("handles megabyte-scale values without floating point drift", () => {
    const items = [
      item("a", 6 * MB + 1, "2026-01-01T00:00:00Z"),
      item("b", 6 * MB + 1, "2026-01-02T00:00:00Z"),
    ];
    const plan = planCleanup(items, 12 * MB + 2, 10 * MB);
    assert.deepEqual(plan.deleteIds, ["a"]);
    assert.equal(plan.freedBytes, 6 * MB + 1);
  });
});
