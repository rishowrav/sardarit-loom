"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteSession,
  getBlob,
  listSessions,
  type UploadSessionMeta,
} from "@/lib/upload/idb";
import {
  runUpload,
  UploadAborted,
  UploadFailed,
  type UploadProgress,
} from "@/lib/upload/uploader";
import UploadProgressView from "./UploadProgressView";
import { useToast } from "./toast";
import { AlertIcon, CloudOffIcon, RefreshIcon, TrashIcon } from "./icons";
import { formatBytes } from "@/lib/utils";

type RowState =
  | { kind: "idle" }
  | { kind: "uploading"; progress: UploadProgress }
  | { kind: "failed"; message: string };

/**
 * Detects interrupted uploads persisted in IndexedDB and offers to resume or
 * discard them — the recording itself is never lost to a crash or reload.
 */
export default function ResumeUploadsBanner() {
  const router = useRouter();
  const toast = useToast();
  const [sessions, setSessions] = useState<UploadSessionMeta[] | null>(null);
  const [states, setStates] = useState<Record<string, RowState>>({});
  const abortControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    let cancelled = false;
    void listSessions().then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function resume(session: UploadSessionMeta) {
    const blob = await getBlob(session.recordingId);
    if (!blob) {
      toast.push(
        "The recorded file is no longer available in this browser — discard the upload and record again.",
        "error",
      );
      return;
    }

    const controller = new AbortController();
    abortControllersRef.current.set(session.recordingId, controller);
    setStates((current) => ({
      ...current,
      [session.recordingId]: {
        kind: "uploading",
        progress: {
          phase: "preparing",
          sentBytes: 0,
          totalBytes: session.sizeBytes,
          partsDone: session.completedParts.length,
          totalParts: session.partCount,
          bytesPerSecond: 0,
        },
      },
    }));

    try {
      const result = await runUpload(
        {
          blob,
          thumbnail: null,
          title: session.title,
          durationSeconds: session.durationSeconds,
          width: session.width,
          height: session.height,
        },
        {
          existing: session,
          signal: controller.signal,
          onProgress: (progress) =>
            setStates((current) => ({
              ...current,
              [session.recordingId]: { kind: "uploading", progress },
            })),
        },
      );
      toast.push(
        `Upload finished — ${formatBytes(result.sizeBytes)} saved.`,
        "success",
      );
      setSessions((current) =>
        (current ?? []).filter((s) => s.recordingId !== session.recordingId),
      );
      router.refresh();
    } catch (error) {
      if (error instanceof UploadAborted) return;
      const message =
        error instanceof UploadFailed
          ? error.message
          : error instanceof Error
            ? error.message
            : "Upload failed";
      setStates((current) => ({
        ...current,
        [session.recordingId]: { kind: "failed", message },
      }));
      toast.push(message, "error");
    } finally {
      abortControllersRef.current.delete(session.recordingId);
    }
  }

  async function discard(session: UploadSessionMeta) {
    if (
      !window.confirm(
        "Discard this unfinished upload? The recorded video will be lost.",
      )
    ) {
      return;
    }
    try {
      await fetch(`/api/uploads/${session.recordingId}/abort`, {
        method: "POST",
      });
    } catch {
      // Row may already be gone server-side.
    }
    await deleteSession(session.recordingId);
    setSessions((current) =>
      (current ?? []).filter((s) => s.recordingId !== session.recordingId),
    );
    toast.push("Unfinished upload discarded.", "info");
    router.refresh();
  }

  if (sessions === null || sessions.length === 0) return null;

  const activeCount = sessions.filter(
    (session) => states[session.recordingId]?.kind !== "failed",
  ).length;

  return (
    <section className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <CloudOffIcon width={18} height={18} className="text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-900">
          {activeCount > 0 || sessions.length > 1
            ? `${sessions.length} unfinished upload${sessions.length === 1 ? "" : "s"}`
            : "1 unfinished upload"}
        </h2>
        <span className="text-xs text-amber-700">
          — pick up where you left off, or discard.
        </span>
      </div>

      <ul className="space-y-3">
        {sessions.map((session) => {
          const state = states[session.recordingId] ?? { kind: "idle" };
          return (
            <li
              key={session.recordingId}
              className="rounded-lg border border-amber-200/70 bg-white p-3"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {session.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatBytes(session.sizeBytes)} ·{" "}
                    {session.completedParts.length}/{session.partCount} chunks
                    uploaded
                  </p>
                </div>
                {state.kind === "idle" ? (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => void resume(session)}
                      className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
                    >
                      <RefreshIcon width={13} height={13} />
                      Resume
                    </button>
                    <button
                      type="button"
                      onClick={() => void discard(session)}
                      className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      <TrashIcon width={13} height={13} />
                      Discard
                    </button>
                  </div>
                ) : null}
              </div>

              {state.kind === "uploading" ? (
                <div className="space-y-2">
                  <UploadProgressView {...state.progress} />
                  <button
                    type="button"
                    onClick={() => {
                      abortControllersRef.current
                        .get(session.recordingId)
                        ?.abort();
                      void discard(session);
                    }}
                    className="text-xs font-medium text-red-600 hover:underline"
                  >
                    Cancel and discard
                  </button>
                </div>
              ) : null}

              {state.kind === "failed" ? (
                <div className="space-y-2">
                  <p className="flex items-start gap-1.5 text-xs text-red-600">
                    <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                    {state.message}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void resume(session)}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => void discard(session)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
