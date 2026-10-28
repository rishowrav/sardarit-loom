"use client";

export interface UploadProgressViewProps {
  phase: "preparing" | "uploading" | "finalizing" | "done";
  sentBytes: number;
  totalBytes: number;
  partsDone: number;
  totalParts: number;
  bytesPerSecond: number;
}

const PHASE_LABELS: Record<UploadProgressViewProps["phase"], string> = {
  preparing: "Preparing upload…",
  uploading: "Uploading…",
  finalizing: "Finalising on the server…",
  done: "Complete",
};

export default function UploadProgressView({
  phase,
  sentBytes,
  totalBytes,
  partsDone,
  totalParts,
  bytesPerSecond,
}: UploadProgressViewProps) {
  const percent =
    totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0;
  const speed =
    phase === "uploading" && bytesPerSecond > 0
      ? `${formatRate(bytesPerSecond)}`
      : null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-slate-700">{PHASE_LABELS[phase]}</span>
        <span className="tabular-nums text-slate-500">
          {percent}%
          {speed ? <span className="ml-2 text-slate-400">{speed}</span> : null}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={
            phase === "done"
              ? "h-full rounded-full bg-emerald-500 transition-all duration-300"
              : "h-full rounded-full bg-indigo-500 transition-all duration-300"
          }
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-400">
        <span className="tabular-nums">
          {formatMb(sentBytes)} / {formatMb(totalBytes)}
        </span>
        {totalParts > 0 ? (
          <span className="tabular-nums">
            chunk {Math.min(partsDone, totalParts)} of {totalParts}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function formatMb(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}
