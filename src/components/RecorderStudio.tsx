"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  RECORD_MODES,
  getMode,
  type RecordMode,
  type RecordModeId,
} from "@/lib/config";
import {
  CaptureError,
  errorMessage,
  isCaptureError,
} from "@/lib/recording/capture";
import {
  getCachedRecordingSupport,
  type SupportCheck,
} from "@/lib/recording/codecs";
import {
  RecordingCancelled,
  RecordingEngine,
} from "@/lib/recording/recorder";
import {
  UploadAborted,
  UploadFailed,
  runUpload,
  type UploadProgress,
} from "@/lib/upload/uploader";
import { deleteSession, getBlob, getSession } from "@/lib/upload/idb";
import UploadProgressView from "./UploadProgressView";
import { useToast } from "./toast";
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  FilmIcon,
  MicIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RecordIcon,
  StopIcon,
  TrashIcon,
} from "./icons";
import { classNames, formatBytes, formatTimer } from "@/lib/utils";

const subscribeNothing = () => () => {};
const getServerSupport = (): SupportCheck | null => null;

const getServerInIframe = (): boolean => false;
const getClientInIframe = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    // Accessing window.top throws from a cross-origin frame → we are framed.
    return true;
  }
};

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
const getClientVisibility = () => document.hidden;
const getServerVisibility = () => false;

type Stage =
  | { id: "setup" }
  | { id: "preparing" }
  | { id: "recording"; paused: boolean }
  | { id: "finalizing" }
  | { id: "uploading"; progress: UploadProgress }
  | { id: "upload-error"; message: string; resumable: boolean }
  | { id: "success"; sizeBytes: number; cleanupDeleted: number };

type Recovery =
  | { kind: "mic"; message: string }
  | { kind: "webcam"; message: string }
  | { kind: "screen"; message: string }
  | null;

export default function RecorderStudio() {
  const toast = useToast();

  const [modeId, setModeId] = useState<RecordModeId>("1080p");
  const [micEnabled, setMicEnabled] = useState(true);
  const [stage, setStage] = useState<Stage>({ id: "setup" });
  const [recovery, setRecovery] = useState<Recovery>(null);
  const [starting, setStarting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [setupError, setSetupError] = useState<string | null>(null);

  const engineRef = useRef<RecordingEngine | null>(null);
  const cameraFallbackRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadSessionIdRef = useRef<string | null>(null);
  const stageRef = useRef<Stage>(stage);
  const finishingRef = useRef(false);

  const support = useSyncExternalStore(
    subscribeNothing,
    getCachedRecordingSupport,
    getServerSupport,
  );
  const inIframe = useSyncExternalStore(
    subscribeNothing,
    getClientInIframe,
    getServerInIframe,
  );
  const tabHidden = useSyncExternalStore(
    subscribeVisibility,
    getClientVisibility,
    getServerVisibility,
  );

  const mode = useMemo(() => getMode(modeId), [modeId]);
  const busy =
    stage.id === "preparing" ||
    stage.id === "recording" ||
    stage.id === "finalizing" ||
    stage.id === "uploading";

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // Elapsed timer while recording.
  useEffect(() => {
    if (stage.id !== "recording") return;
    const interval = setInterval(() => {
      const engine = engineRef.current;
      if (engine) setElapsedMs(engine.elapsedMs);
    }, 250);
    return () => clearInterval(interval);
  }, [stage.id]);

  // Prevent accidental navigation while recording or uploading.
  useEffect(() => {
    if (!busy) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  // Screen wake lock keeps the device from sleeping mid-recording.
  useEffect(() => {
    if (stage.id !== "recording") return;
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((value) => {
        if (cancelled) void value.release().catch(() => undefined);
        else lock = value;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void lock?.release().catch(() => undefined);
    };
  }, [stage.id]);

  const cleanup = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    uploadAbortRef.current = null;
    uploadSessionIdRef.current = null;
    finishingRef.current = false;
    setElapsedMs(0);
  }, []);

  /** Runs after the engine produced (or failed to produce) a result. */
  const finishRecording = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    const engine = engineRef.current;
    if (!engine?.result) {
      finishingRef.current = false;
      setStage({ id: "setup" });
      return;
    }

    setStage({ id: "finalizing" });
    try {
      const result = await engine.result;
      engine.destroy();
      engineRef.current = null;

      setStage({
        id: "uploading",
        progress: {
          phase: "preparing",
          sentBytes: 0,
          totalBytes: result.blob.size,
          partsDone: 0,
          totalParts: 0,
          bytesPerSecond: 0,
        },
      });

      const controller = new AbortController();
      uploadAbortRef.current = controller;

      const uploadResult = await runUpload(
        {
          blob: result.blob,
          thumbnail: result.thumbnail,
          title: defaultTitle(),
          durationSeconds: result.durationMs / 1000,
          width: result.width,
          height: result.height,
        },
        {
          signal: controller.signal,
          onSessionCreated: (id) => {
            uploadSessionIdRef.current = id;
          },
          onProgress: (progress) =>
            setStage({ id: "uploading", progress }),
        },
      );

      setStage({
        id: "success",
        sizeBytes: uploadResult.sizeBytes,
        cleanupDeleted: uploadResult.cleanup.deletedCount,
      });
      toast.push(`Recording saved — ${formatBytes(uploadResult.sizeBytes)}.`, "success");
      if (uploadResult.cleanup.deletedCount > 0) {
        toast.push(
          `Storage limit reached: removed ${uploadResult.cleanup.deletedCount} oldest recording${uploadResult.cleanup.deletedCount === 1 ? "" : "s"}.`,
          "info",
        );
      }
      if (uploadResult.cleanup.errors.length > 0) {
        toast.push(`Cleanup warning: ${uploadResult.cleanup.errors[0]}`, "error");
      }
    } catch (error) {
      if (error instanceof RecordingCancelled) {
        setStage({ id: "setup" });
        toast.push("Recording discarded.", "info");
      } else if (error instanceof UploadAborted) {
        setStage({ id: "setup" });
      } else if (error instanceof UploadFailed) {
        setStage({
          id: "upload-error",
          message: error.message,
          resumable: error.resumable,
        });
        toast.push(error.message, "error");
      } else {
        const message = errorMessage(error);
        setStage({ id: "upload-error", message, resumable: false });
        toast.push(message, "error");
      }
    } finally {
      uploadAbortRef.current = null;
      finishingRef.current = false;
      setElapsedMs(0);
    }
  }, [toast]);

  /** React to engine phase changes (notably browser-initiated stops). */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    return engine.subscribe((phase) => {
      if (phase === "stopping" || phase === "done") {
        const current = stageRef.current;
        if (current.id === "recording" || current.id === "finalizing") {
          void finishRecording();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.id === "recording"]);

  async function startRecording() {
    if (starting || busy) return;
    setStarting(true);
    setSetupError(null);
    setRecovery(null);

    const engine =
      engineRef.current ??
      new RecordingEngine((error) => {
        toast.push(error.message, "error");
        void finishRecording();
      });
    engineRef.current = engine;

    try {
      await engine.prepare(mode, {
        mic: micEnabled,
        webcam: mode.withWebcam,
        cameraFallback: cameraFallbackRef.current,
      });
      cameraFallbackRef.current = false;
    } catch (error) {
      if (isCaptureError(error, "mic_denied") || isCaptureError(error, "mic_missing")) {
        setRecovery({ kind: "mic", message: errorMessage(error) });
        setStarting(false);
        return; // engine keeps the cached screen capture
      }
      if (
        isCaptureError(error, "webcam_denied") ||
        isCaptureError(error, "webcam_missing")
      ) {
        if (support && !support.screenSupported) {
          // The camera is the only video source here — show a plain error
          // instead of a "continue without webcam" recovery that can't work.
          cleanup();
          setSetupError(errorMessage(error));
          setStarting(false);
          return;
        }
        setRecovery({ kind: "webcam", message: errorMessage(error) });
        setStarting(false);
        return;
      }
      if (
        isCaptureError(error, "screen_denied") ||
        isCaptureError(error, "screen_unavailable")
      ) {
        setRecovery({ kind: "screen", message: errorMessage(error) });
        setStarting(false);
        return;
      }
      const message =
        error instanceof CaptureError ? error.message : errorMessage(error);
      cleanup();
      setSetupError(message);
      setStarting(false);
      return;
    }

    try {
      await engine.start();
    } catch (error) {
      cleanup();
      setSetupError(errorMessage(error));
      toast.push(errorMessage(error), "error");
      setStarting(false);
      return;
    }

    setElapsedMs(0);
    setStage({ id: "recording", paused: false });
    setStarting(false);
  }

  function togglePause() {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.currentPhase === "recording") {
      engine.pause();
      setStage({ id: "recording", paused: true });
    } else if (engine.currentPhase === "paused") {
      engine.resume();
      setStage({ id: "recording", paused: false });
    }
  }

  function stopRecording() {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.stop().catch(() => undefined);
    // finishRecording() is invoked by the phase subscription.
  }

  function cancelRecording() {
    if (!window.confirm("Discard this recording? It will not be saved.")) return;
    const engine = engineRef.current;
    if (!engine) {
      setStage({ id: "setup" });
      return;
    }
    setStage({ id: "finalizing" });
    engine.cancel();
    void finishRecording();
  }

  function cancelUpload() {
    if (!window.confirm("Cancel the upload and discard this recording?")) return;
    uploadAbortRef.current?.abort();
    void (async () => {
      const recordingId = uploadSessionIdRef.current;
      if (recordingId) {
        try {
          await fetch(`/api/uploads/${recordingId}/abort`, { method: "POST" });
        } catch {
          // Row may not exist yet or already be gone.
        }
        await deleteSession(recordingId);
      }
      cleanup();
      setStage({ id: "setup" });
      toast.push("Upload cancelled and recording discarded.", "info");
    })();
  }

  async function retryUpload() {
    const sessionId = uploadSessionIdRef.current;
    if (!sessionId) {
      setStage({ id: "setup" });
      return;
    }
    const session = await getSession(sessionId);
    const blob = await getBlob(sessionId);
    if (!session || !blob) {
      await deleteSession(sessionId);
      toast.push(
        "The recording file is no longer available — please record again.",
        "error",
      );
      setStage({ id: "setup" });
      return;
    }

    setStage({
      id: "uploading",
      progress: {
        phase: "preparing",
        sentBytes: 0,
        totalBytes: session.sizeBytes,
        partsDone: session.completedParts.length,
        totalParts: session.partCount,
        bytesPerSecond: 0,
      },
    });

    const controller = new AbortController();
    uploadAbortRef.current = controller;
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
          onProgress: (progress) => setStage({ id: "uploading", progress }),
        },
      );
      setStage({
        id: "success",
        sizeBytes: result.sizeBytes,
        cleanupDeleted: result.cleanup.deletedCount,
      });
      toast.push("Upload finished.", "success");
    } catch (error) {
      if (error instanceof UploadAborted) return;
      const message = errorMessage(error);
      setStage({
        id: "upload-error",
        message,
        resumable: !(error instanceof UploadFailed && !error.resumable),
      });
      toast.push(message, "error");
    } finally {
      uploadAbortRef.current = null;
    }
  }

  async function discardFailedUpload() {
    const recordingId = uploadSessionIdRef.current;
    if (
      !window.confirm("Discard this recording permanently? It cannot be recovered.")
    ) {
      return;
    }
    if (recordingId) {
      try {
        await fetch(`/api/uploads/${recordingId}/abort`, { method: "POST" });
      } catch {
        // Already gone.
      }
      await deleteSession(recordingId);
    }
    cleanup();
    setStage({ id: "setup" });
    toast.push("Recording discarded.", "info");
  }

  function resetToSetup() {
    cleanup();
    cameraFallbackRef.current = false;
    setRecovery(null);
    setSetupError(null);
    setStage({ id: "setup" });
  }

  if (support && !support.supported) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
          <AlertIcon width={22} height={22} />
        </span>
        <h1 className="text-lg font-semibold text-slate-900">
          Recording is not available here
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          {support.reason}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          Open <strong>http://localhost:3000</strong> directly in Chrome or
          Edge (not an embedded preview frame) — screen capture needs a full
          browser window.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/library"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Back to library
          </Link>
          <a
            href="/record"
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Open in new tab
          </a>
        </div>
      </div>
    );
  }

  if (stage.id === "success") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <CheckIcon width={24} height={24} />
        </span>
        <h1 className="text-lg font-semibold text-slate-900">Recording saved</h1>
        <p className="mt-1 text-sm text-slate-500">
          {formatBytes(stage.sizeBytes)} uploaded securely.
          {stage.cleanupDeleted > 0
            ? ` Cleanup removed ${stage.cleanupDeleted} oldest video${stage.cleanupDeleted === 1 ? "" : "s"} to stay within your storage limit.`
            : ""}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/library"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            View library
          </Link>
          <button
            type="button"
            onClick={resetToSetup}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Record another
          </button>
        </div>
      </div>
    );
  }

  if (stage.id === "uploading" || stage.id === "upload-error") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <FilmIcon width={18} height={18} />
          </span>
          <div>
            <h1 className="text-base font-semibold text-slate-900">
              {stage.id === "uploading" ? "Uploading recording" : "Upload interrupted"}
            </h1>
            <p className="text-xs text-slate-500">
              Large files upload in chunks and can always be resumed.
            </p>
          </div>
        </div>

        {stage.id === "uploading" ? (
          <UploadProgressView {...stage.progress} />
        ) : (
          <div className="mb-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-red-200">
            {stage.message}
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          {stage.id === "uploading" ? (
            <button
              type="button"
              onClick={cancelUpload}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel upload
            </button>
          ) : (
            <>
              {stage.resumable ? (
                <button
                  type="button"
                  onClick={() => void retryUpload()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Retry upload
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void discardFailedUpload()}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (stage.id === "finalizing") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-slate-200">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
          <RecordIcon width={22} height={22} className="animate-pulse" />
        </span>
        <h1 className="text-lg font-semibold text-slate-900">
          Processing recording…
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Preparing the file for upload.
        </p>
      </div>
    );
  }

  if (stage.id === "recording") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-col items-center py-6">
          <div className="flex items-center gap-3">
            <span
              className={classNames(
                "h-3 w-3 rounded-full",
                stage.paused ? "bg-amber-500" : "animate-pulse bg-red-500",
              )}
            />
            <span
              className={classNames(
                "text-sm font-semibold uppercase tracking-wide",
                stage.paused ? "text-amber-600" : "text-red-600",
              )}
            >
              {stage.paused ? "Paused" : "Recording"}
            </span>
          </div>
          <p className="mt-3 text-5xl font-semibold tabular-nums tracking-tight text-slate-900">
            {formatTimer(elapsedMs)}
          </p>
          <p className="mt-2 flex items-center gap-3 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <MonitorIcon width={13} height={13} />
              {mode.shortLabel}
            </span>
            <span className="inline-flex items-center gap-1">
              <MicIcon width={13} height={13} />
              {micEnabled ? "Mic on" : "Mic off"}
            </span>
            {mode.withWebcam ? (
              <span className="inline-flex items-center gap-1">
                <CameraIcon width={13} height={13} />
                Camera on
              </span>
            ) : null}
          </p>
        </div>

        {tabHidden ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
            Keep this tab visible while recording — background tabs can freeze
            the captured frames.
          </div>
        ) : null}

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={togglePause}
            className={classNames(
              "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition",
              stage.paused
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200",
            )}
          >
            {stage.paused ? <PlayIcon width={15} height={15} /> : <PauseIcon width={15} height={15} />}
            {stage.paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={stopRecording}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500"
          >
            <StopIcon width={14} height={14} />
            Stop
          </button>
          <button
            type="button"
            onClick={cancelRecording}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 transition hover:text-red-600"
          >
            <TrashIcon width={15} height={15} />
            Discard
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          Stopping also happens from the browser&apos;s own “Stop sharing” bar.
        </p>
      </div>
    );
  }

  // --- setup stage -------------------------------------------------------
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          New recording
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Choose a mode — you&apos;ll be asked for screen (and optionally
          microphone/camera) permission.
        </p>
      </div>

       {inIframe || (support && !support.screenSupported) ? (
        <div
          role="status"
          className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900"
        >
          <p className="font-semibold">
            {inIframe
              ? "Screen recording is blocked in this embedded preview."
              : "Screen capture isn't available in this browser/device."}
          </p>
          <p className="mt-1 text-indigo-800">
            {inIframe
              ? "Browsers only allow screen capture from a top-level window — this page is inside an iframe, so no share dialog can appear here. Open the record page in a new tab and screen share will work. You can still record with your camera and microphone here."
              : "This environment doesn't expose screen sharing (common on mobile browsers). Open this page in desktop Chrome or Edge for full-screen recording, or record with your camera and microphone instead."}
          </p>
          <a
            href="/record"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
          >
            <MonitorIcon width={15} height={15} />
            Open record page in new tab
          </a>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {RECORD_MODES.map((option) => (
          <ModeCard
            key={option.id}
            mode={option}
            selected={option.id === modeId}
            disabled={busy || starting}
            onSelect={() => {
              setModeId(option.id);
              setRecovery(null);
            }}
          />
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-4 rounded-xl bg-white px-4 py-3 ring-1 ring-slate-200">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={micEnabled}
            onChange={(event) => setMicEnabled(event.target.checked)}
            disabled={busy || starting}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <MicIcon width={15} height={15} className="text-slate-400" />
          Microphone
        </label>
        <p className="text-xs text-slate-400">
          Tip: enable “Share tab audio” in the share dialog for system sound.
        </p>
      </div>

      {recovery ? (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm text-amber-900">{recovery.message}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (recovery.kind === "mic") {
                      setMicEnabled(false);
                    } else {
                      setModeId("1080p");
                    }
                    setRecovery(null);
                    setTimeout(() => void startRecording(), 0);
                  }}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  {recovery.kind === "mic"
                    ? "Continue without microphone"
                    : recovery.kind === "screen"
                      ? "Record with camera instead"
                      : "Continue without webcam"}
                </button>
                {recovery.kind === "screen" ? (
                  <a
                    href="/record"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700"
                  >
                    Open in new tab for screen share
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {setupError && !recovery ? (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {setupError}
        </div>
      ) : null}

      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => void startRecording()}
          disabled={starting || busy}
          className="inline-flex items-center gap-2.5 rounded-xl bg-red-600 px-7 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-red-500 disabled:opacity-60"
        >
          <span className="flex h-3 w-3 items-center justify-center rounded-full bg-white">
            <span className="h-2 w-2 rounded-full bg-red-600" />
          </span>
          {starting ? "Requesting access…" : "Start recording"}
        </button>
        <p className="mt-3 text-xs text-slate-400">
          No fixed time limit — practical limits depend on your device and
          browser.
        </p>
      </div>
    </div>
  );
}

function ModeCard({
  mode,
  selected,
  disabled,
  onSelect,
}: {
  mode: RecordMode;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={classNames(
        "rounded-xl border p-4 text-left transition disabled:opacity-50",
        selected
          ? "border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-200"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">{mode.label}</span>
        <span
          className={classNames(
            "flex h-4 w-4 items-center justify-center rounded-full border",
            selected
              ? "border-indigo-600 bg-indigo-600 text-white"
              : "border-slate-300",
          )}
        >
          {selected ? <CheckIcon width={10} height={10} /> : null}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
        {mode.description}
      </p>
      <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {mode.width}×{mode.height}
      </p>
    </button>
  );
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
