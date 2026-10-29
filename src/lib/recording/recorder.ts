import { AUDIO_BITS_PER_SECOND, type RecordMode } from "@/lib/config";
import {
  CaptureError,
  captureCamera,
  captureDisplay,
  captureMicrophone,
  captureWebcam,
  hasDisplayCapture,
  isCaptureError,
} from "@/lib/recording/capture";
import { pickMimeType } from "@/lib/recording/codecs";
import { ScreenCompositor } from "@/lib/recording/compositor";

export type EnginePhase =
  | "idle"
  | "preparing"
  | "recording"
  | "paused"
  | "stopping"
  | "done";

export interface PrepareResult {
  warnings: string[];
  hasMic: boolean;
  hasSystemAudio: boolean;
  hasWebcam: boolean;
}

export interface RecorderResult {
  blob: Blob;
  thumbnail: Blob | null;
  durationMs: number;
  width: number;
  height: number;
  mimeType: string;
}

export class RecordingCancelled extends Error {
  constructor() {
    super("Recording cancelled");
    this.name = "RecordingCancelled";
  }
}

export type EngineListener = (phase: EnginePhase) => void;

const TIMESLICE_MS = 1000;

/**
 * Drives the whole capture pipeline: sources → compositor → MediaRecorder,
 * with pause/resume and a pause-aware elapsed timer (no fixed limit — the
 * browser/device may impose practical limits, but the app never does).
 */
export class RecordingEngine {
  private mode: RecordMode | null = null;
  private display: MediaStream | null = null;
  /** True when the main video source is the camera (no screen capture). */
  private sourceIsCamera = false;
  private mic: MediaStream | null = null;
  private webcam: MediaStream | null = null;
  private compositor: ScreenCompositor | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private phase: EnginePhase = "idle";
  private listeners = new Set<EngineListener>();

  private startedAt = 0;
  private pauseStartedAt = 0;
  private totalPausedMs = 0;
  private frozenElapsedMs = 0;

  private deferred: {
    promise: Promise<RecorderResult>;
    resolve: (result: RecorderResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private cancelled = false;
  private mimeType = "";

  /** Optional hook: fatal MediaRecorder errors while recording. */
  onError: ((error: Error) => void) | null = null;

  constructor(onError?: (error: Error) => void) {
    this.onError = onError ?? null;
  }

  private createDeferred() {
    let resolve!: (result: RecorderResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RecorderResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Avoid unhandled-rejection noise when callers don't await (cancel paths).
    promise.catch(() => undefined);
    this.deferred = { promise, resolve, reject };
  }

  /** Resolves/rejects when the recording finishes (also for auto-stops). */
  get result(): Promise<RecorderResult> | null {
    return this.deferred?.promise ?? null;
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  get elapsedMs(): number {
    if (this.phase === "recording") {
      return performance.now() - this.startedAt - this.totalPausedMs;
    }
    if (this.phase === "paused") {
      return this.pauseStartedAt - this.startedAt - this.totalPausedMs;
    }
    return this.frozenElapsedMs;
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setPhase(phase: EnginePhase) {
    this.phase = phase;
    for (const listener of this.listeners) listener(phase);
  }

  /**
   * Acquires sources for the chosen mode. The display capture is cached, so
   * calling prepare() again after declining the mic/camera reuses it instead
   * of re-prompting for the screen.
   */
  async prepare(
    mode: RecordMode,
    options: { mic: boolean; webcam: boolean; cameraFallback?: boolean },
  ): Promise<PrepareResult> {
    this.mode = mode;
    const warnings: string[] = [];

    if (!this.display) {
      const forceCamera = options.cameraFallback === true;
      const noScreenApi = !hasDisplayCapture();

      if (forceCamera) {
        this.display = await captureCamera(mode.width, mode.height);
        this.sourceIsCamera = true;
        warnings.push(
          "Recording from the camera (screen capture disabled by choice).",
        );
      } else if (noScreenApi) {
        throw new CaptureError(
          "screen_unavailable",
          "Screen capture isn't available in this browser/device. Try desktop Chrome/Edge, or record with the camera instead.",
        );
      } else {
        try {
          this.display = await captureDisplay(mode.width, mode.height);
          this.sourceIsCamera = false;
        } catch (error) {
          // Don't silently fall back to the camera — surface the error so the
          // UI can offer an explicit "record with camera instead" choice.
          throw error;
        }
      }
    }

    let hasMic = false;
    if (options.mic) {
      this.mic = await captureMicrophone(); // throws typed CaptureError for the UI
      hasMic = true;
    }

    let hasWebcam = false;
    if (options.webcam && !this.sourceIsCamera) {
      this.webcam = await captureWebcam();
      hasWebcam = true;
    } else if (options.webcam && this.sourceIsCamera) {
      warnings.push("Webcam bubble skipped — the camera is the main video source.");
    }

    const systemAudioTracks = this.display.getAudioTracks();
    if (!hasMic && systemAudioTracks.length === 0 && options.mic) {
      warnings.push("Recording without audio — no microphone or system audio.");
    }

    // If the user closes the browser's "Stop sharing" bar, finish recording.
    const displayTrack = this.display.getVideoTracks()[0];
    displayTrack?.addEventListener("ended", () => {
      if (this.phase === "recording" || this.phase === "paused") {
        void this.stop().catch(() => undefined);
      }
    });

    return {
      warnings,
      hasMic,
      hasSystemAudio: systemAudioTracks.length > 0,
      hasWebcam,
    };
  }

  /** Builds the pipeline and starts recording immediately. */
  async start(): Promise<void> {
    if (!this.mode || !this.display) {
      throw new Error("prepare() must succeed before start()");
    }
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("No supported recording codec found.");
    this.mimeType = mimeType;

    this.compositor = new ScreenCompositor({
      width: this.mode.width,
      height: this.mode.height,
      display: this.display,
      webcam: this.webcam,
      audio: {
        mic: this.mic?.getAudioTracks() ?? [],
        system: this.display.getAudioTracks(),
      },
    });
    const stream = await this.compositor.start();

    this.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: this.mode.videoBitsPerSecond,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    this.chunks = [];
    this.cancelled = false;

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => {
      const error = new Error(
        "The browser stopped the recording unexpectedly (it may be out of storage or memory).",
      );
      this.deferred?.reject(error);
      this.onError?.(error);
    };
    this.recorder.onstop = () => {
      void this.finalize();
    };

    this.createDeferred();
    this.recorder.start(TIMESLICE_MS);
    this.startedAt = performance.now();
    this.totalPausedMs = 0;
    this.pauseStartedAt = 0;
    this.frozenElapsedMs = 0;
    this.setPhase("recording");
  }

  pause() {
    if (this.phase !== "recording" || !this.recorder) return;
    this.recorder.pause();
    this.pauseStartedAt = performance.now();
    this.compositor?.setPaused(true);
    this.setPhase("paused");
  }

  resume() {
    if (this.phase !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.totalPausedMs += performance.now() - this.pauseStartedAt;
    this.pauseStartedAt = 0;
    this.compositor?.setPaused(false);
    this.setPhase("recording");
  }

  /**
   * Stops recording and resolves with the final blob + thumbnail. Safe to
   * call multiple times (e.g. the user presses Stop while the browser's own
   * "Stop sharing" action already triggered the stop).
   */
  stop(): Promise<RecorderResult> {
    if (!this.deferred) {
      return Promise.reject(new Error("Not recording"));
    }
    if (this.phase === "recording" || this.phase === "paused") {
      this.frozenElapsedMs = this.elapsedMs;
      this.setPhase("stopping");
      try {
        if (this.recorder && this.recorder.state !== "inactive") {
          this.recorder.stop();
        } else {
          void this.finalize();
        }
      } catch (error) {
        this.deferred.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return this.deferred.promise;
  }

  /** Discards the recording without producing a result. */
  cancel() {
    this.cancelled = true;
    this.frozenElapsedMs = this.elapsedMs;
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore — finalize() will still clean up
      }
    } else {
      void this.finalize();
    }
  }

  async captureThumbnail(): Promise<Blob | null> {
    return this.compositor?.captureThumbnail() ?? null;
  }

  private async finalize() {
    if (this.phase === "done") return;
    this.setPhase("stopping");

    const durationMs = this.frozenElapsedMs;
    const thumbnail = await (async () => {
      try {
        return (await this.compositor?.captureThumbnail()) ?? null;
      } catch {
        return null;
      }
    })();

    const type = this.recorder?.mimeType || this.mimeType || "video/webm";
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];

    const mode = this.mode;
    this.setPhase("done");

    const deferred = this.deferred;
    if (!deferred) return;

    if (this.cancelled) {
      deferred.reject(new RecordingCancelled());
      return;
    }
    if (blob.size === 0) {
      deferred.reject(
        new Error(
          "The recording produced no data — check available storage and try again.",
        ),
      );
      return;
    }

    deferred.resolve({
      blob,
      thumbnail,
      durationMs,
      width: mode?.width ?? 0,
      height: mode?.height ?? 0,
      mimeType: type,
    });
  }

  /** Releases every stream, track and canvas. Safe to call multiple times. */
  destroy() {
    this.setPhase("idle");
    this.compositor?.destroy();
    this.compositor = null;

    const streams = [this.display, this.mic, this.webcam];
    for (const stream of streams) {
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          // already stopped
        }
      }
    }
    this.display = null;
    this.mic = null;
    this.webcam = null;
    this.recorder = null;
    this.chunks = [];
    this.mode = null;
    this.sourceIsCamera = false;
  }

  /** For UI messaging: what sources were granted. */
  get activeSources() {
    return {
      display: Boolean(this.display),
      cameraSource: this.sourceIsCamera,
      mic: Boolean(this.mic),
      webcam: Boolean(this.webcam),
      systemAudio: (this.display?.getAudioTracks().length ?? 0) > 0,
    };
  }
}
