import { TARGET_FPS } from "@/lib/config";

/**
 * Composes the recording onto a fixed-size canvas:
 *  - screen video, aspect-fitted with letterboxing (output resolution always
 *    matches the selected 720p/1080p mode),
 *  - optional webcam picture-in-picture bubble (rounded, bottom-right),
 *  - mixes microphone + system audio through Web Audio.
 *
 * Frame drawing prefers `requestVideoFrameCallback` (one draw per captured
 * frame) with rAF/setInterval fallbacks so the output keeps updating even
 * when the browser throttles timers (e.g. a background tab — the UI warns
 * the user to keep the tab visible).
 */

export interface CompositorAudio {
  /** Microphone tracks — cleaned up, compressed and levelled for speech. */
  mic: MediaStreamTrack[];
  /** Screen/tab audio — kept as close to the original mix as possible. */
  system: MediaStreamTrack[];
}

export interface CompositorOptions {
  width: number;
  height: number;
  display: MediaStream;
  webcam?: MediaStream | null;
  audio: CompositorAudio;
}

function loadVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const onLoaded = () => {
      cleanup();
      video.play().then(() => resolve(video)).catch(() => resolve(video));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Video source failed to load"));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

export class ScreenCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: CompositorOptions;
  private displayVideo: HTMLVideoElement | null = null;
  private webcamVideo: HTMLVideoElement | null = null;
  private audioContext: AudioContext | null = null;
  private outputStream: MediaStream | null = null;
  private rafHandle: number | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private rvcHandle: number | null = null;
  private lastDrawAt = 0;
  private running = false;
  private paused = false;

  constructor(options: CompositorOptions) {
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.width = options.width;
    this.canvas.height = options.height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  /** Prepares sources and returns the mixed stream ready for MediaRecorder. */
  async start(): Promise<MediaStream> {
    const { display, webcam, audio } = this.options;

    this.displayVideo = await loadVideo(display);
    if (webcam && webcam.getVideoTracks().length > 0) {
      try {
        this.webcamVideo = await loadVideo(webcam);
      } catch {
        this.webcamVideo = null; // degrade to screen-only instead of failing
      }
    }

    const canvasStream = this.canvas.captureStream(TARGET_FPS);
    const videoTrack = canvasStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("Could not capture canvas output");

    const mixedAudio = await this.mixAudio(audio);
    this.outputStream = new MediaStream([
      videoTrack,
      ...mixedAudio.map((t) => t),
    ]);

    this.running = true;
    this.draw(); // paint the first frame immediately
    this.schedule();

    // Safety net: keeps frames flowing when rVFC/rAF are throttled.
    this.intervalHandle = setInterval(() => this.draw(), 40);

    return this.outputStream;
  }

  /**
   * Builds a clean stereo mix:
   *  mic    → high-pass (kills rumble/hum) → voice compressor → gain
   *  system → simple trim, no voice processing (keeps original fidelity)
   *  both   → master limiter (prevents clipping) → destination
   */
  private async mixAudio(audio: CompositorAudio): Promise<MediaStreamTrack[]> {
    const mic = audio.mic.filter((track) => track.readyState === "live");
    const system = audio.system.filter((track) => track.readyState === "live");
    if (mic.length === 0 && system.length === 0) return [];

    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtor) return [];

      let audioContext: AudioContext;
      try {
        // 48 kHz matches the capture side and avoids an extra resample.
        audioContext = new AudioCtor({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
      } catch {
        audioContext = new AudioCtor();
      }
      this.audioContext = audioContext;

      const destination = audioContext.createMediaStreamDestination();

      // Master limiter: keeps the mix from clipping even when the mic and
      // system audio peak at the same time.
      const limiter = audioContext.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      limiter.connect(destination);

      for (const track of mic) {
        const source = audioContext.createMediaStreamSource(
          new MediaStream([track]),
        );
        // 90 Hz high-pass removes fan noise, desk thumps and mains hum.
        const highpass = audioContext.createBiquadFilter();
        highpass.type = "highpass";
        highpass.frequency.value = 90;
        highpass.Q.value = 0.7;

        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 24;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        const gain = audioContext.createGain();
        gain.gain.value = 1.15;

        source
          .connect(highpass)
          .connect(compressor)
          .connect(gain)
          .connect(limiter);
      }

      for (const track of system) {
        const source = audioContext.createMediaStreamSource(
          new MediaStream([track]),
        );
        const gain = audioContext.createGain();
        gain.gain.value = 0.85;
        source.connect(gain).connect(limiter);
      }

      await audioContext.resume().catch(() => undefined);
      return destination.stream.getAudioTracks();
    } catch {
      return [];
    }
  }

  private schedule() {
    if (!this.running) return;
    const display = this.displayVideo as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        })
      | null;

    if (display?.requestVideoFrameCallback) {
      const tick = () => {
        if (!this.running) return;
        this.draw();
        this.rvcHandle = display.requestVideoFrameCallback(tick);
      };
      this.rvcHandle = display.requestVideoFrameCallback(tick);
      return;
    }
    const raf = () => {
      if (!this.running) return;
      this.draw();
      this.rafHandle = requestAnimationFrame(raf);
    };
    this.rafHandle = requestAnimationFrame(raf);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) this.draw();
  }

  private draw() {
    if (!this.running || this.paused) return;
    const now = performance.now();
    if (now - this.lastDrawAt < 1000 / (TARGET_FPS * 1.5)) return;
    this.lastDrawAt = now;

    const { width, height } = this.canvas;
    const ctx = this.ctx;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    const display = this.displayVideo;
    if (display && display.readyState >= 2) {
      drawContain(ctx, display, width, height);
    }

    const webcam = this.webcamVideo;
    if (
      webcam &&
      webcam.readyState >= 2 &&
      this.options.webcam?.getVideoTracks().some((t) => t.readyState === "live")
    ) {
      drawPip(ctx, webcam, width, height);
    }
  }

  /** Captures the current frame as a JPEG (used as library thumbnail). */
  async captureThumbnail(): Promise<Blob | null> {
    this.drawForce();
    return new Promise((resolve) => {
      try {
        this.canvas.toBlob(
          (blob) => resolve(blob),
          "image/jpeg",
          0.72,
        );
      } catch {
        resolve(null);
      }
    });
  }

  private drawForce() {
    const wasPaused = this.paused;
    this.paused = false;
    this.lastDrawAt = 0;
    this.draw();
    this.paused = wasPaused;
  }

  /** Stops drawing but keeps the canvas (last frame stays for thumbnails). */
  stopDrawing() {
    this.running = false;
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
    if (this.rvcHandle != null && this.displayVideo?.cancelVideoFrameCallback) {
      this.displayVideo.cancelVideoFrameCallback(this.rvcHandle);
    }
    if (this.intervalHandle != null) clearInterval(this.intervalHandle);
    this.rafHandle = null;
    this.rvcHandle = null;
    this.intervalHandle = null;
  }

  /** Stops drawing and releases every source and audio resource. */
  destroy() {
    this.stopDrawing();
    for (const element of [this.displayVideo, this.webcamVideo]) {
      if (!element) continue;
      element.pause();
      element.srcObject = null;
      element.removeAttribute("src");
    }
    this.displayVideo = null;
    this.webcamVideo = null;

    const tracks = [
      ...(this.outputStream?.getTracks() ?? []),
      ...this.options.display.getTracks(),
      ...(this.options.webcam?.getTracks() ?? []),
      ...this.options.audio.mic,
      ...this.options.audio.system,
    ];
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // already stopped
      }
    }
    this.outputStream = null;

    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  canvasWidth: number,
  canvasHeight: number,
) {
  const sw =
    "videoWidth" in source ? (source as HTMLVideoElement).videoWidth : 0;
  const sh =
    "videoHeight" in source ? (source as HTMLVideoElement).videoHeight : 0;
  if (!sw || !sh) return;

  const scale = Math.min(canvasWidth / sw, canvasHeight / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (canvasWidth - dw) / 2;
  const dy = (canvasHeight - dh) / 2;
  ctx.drawImage(source, dx, dy, dw, dh);
}

function drawPip(
  ctx: CanvasRenderingContext2D,
  webcam: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
) {
  const vw = webcam.videoWidth;
  const vh = webcam.videoHeight;
  if (!vw || !vh) return;

  const pipWidth = Math.round(canvasWidth * 0.22);
  const pipHeight = Math.round(pipWidth * (vh / vw));
  const margin = Math.round(canvasWidth * 0.025);
  const x = canvasWidth - pipWidth - margin;
  const y = canvasHeight - pipHeight - margin;
  const radius = Math.max(8, Math.round(pipWidth * 0.06));

  // Cover-crop the webcam feed into the bubble.
  const scale = Math.max(pipWidth / vw, pipHeight / vh);
  const sourceW = pipWidth / scale;
  const sourceH = pipHeight / scale;
  const sourceX = (vw - sourceW) / 2;
  const sourceY = (vh - sourceH) / 2;

  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, pipWidth, pipHeight, radius);
  } else {
    ctx.rect(x, y, pipWidth, pipHeight);
  }
  ctx.clip();
  ctx.drawImage(
    webcam,
    sourceX,
    sourceY,
    sourceW,
    sourceH,
    x,
    y,
    pipWidth,
    pipHeight,
  );
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, pipWidth, pipHeight, radius);
  } else {
    ctx.rect(x, y, pipWidth, pipHeight);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(2, Math.round(canvasWidth / 640));
  ctx.stroke();
  ctx.restore();
}
