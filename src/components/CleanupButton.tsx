"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./toast";
import { RefreshIcon } from "./icons";
import { formatBytes } from "@/lib/utils";

interface CleanupResponse {
  deletedCount: number;
  freedBytes: number;
  usedBytes: number;
  limitBytes: number;
  errors: string[];
}

export default function CleanupButton() {
  const router = useRouter();
  const toast = useToast();
  const [running, setRunning] = useState(false);

  async function run() {
    if (running) return;
    if (
      !window.confirm(
        "Run storage cleanup now? The oldest completed videos will be removed if you are over the configured limit.",
      )
    ) {
      return;
    }
    setRunning(true);
    try {
      const response = await fetch("/api/storage", { method: "POST" });
      const data = (await response.json().catch(() => null)) as
        | (CleanupResponse & { error?: string })
        | null;
      if (!response.ok || !data) {
        throw new Error(data?.error ?? "Cleanup failed");
      }
      if (data.deletedCount > 0) {
        toast.push(
          `Removed ${data.deletedCount} oldest video${data.deletedCount === 1 ? "" : "s"}, freeing ${formatBytes(data.freedBytes)}.`,
          "success",
        );
      } else {
        toast.push(
          `Storage is within the limit — nothing to remove (${formatBytes(data.usedBytes)} used).`,
          "info",
        );
      }
      if (data.errors?.length) {
        toast.push(`Cleanup warning: ${data.errors[0]}`, "error");
      }
      router.refresh();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "Cleanup failed",
        "error",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={running}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
    >
      <RefreshIcon width={15} height={15} className={running ? "animate-spin" : undefined} />
      {running ? "Checking…" : "Run cleanup now"}
    </button>
  );
}
