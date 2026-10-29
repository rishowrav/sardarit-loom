"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { classNames, formatDuration } from "@/lib/utils";
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  ExitFullscreenIcon,
  ForwardIcon,
  FullscreenIcon,
  LoopIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  RewindIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from "./icons";

interface VideoPlayerProps {
  initialUrl: string;
  poster?: string | null;
  /** Endpoint returning `{ url }` again when the temporary link expires. */
  refreshUrl?: string;
  /** Optional direct download link shown as a button in the controls. */
  downloadUrl?: string | null;
  /**
   * Known length in seconds (from the database). MediaRecorder WebM files
   * often report `Infinity`, so this keeps the seek bar usable immediately.
   */
  durationHint?: number | null;
  className?: string;
  title?: string;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const SKIP_SECONDS = 10;
const HIDE_CONTROLS_DELAY = 2800;

const subscribeNothing = () => () => {};
const getPipSupported = (): boolean =>
  typeof document !== "undefined" &&
  document.pictureInPictureEnabled === true &&
  typeof HTMLVideoElement !== "undefined" &&
  "requestPictureInPicture" in HTMLVideoElement.prototype;
const getPipUnsupported = () => false;

function positiveDuration(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Full-featured custom video player (Loom-style):
 *  - play/pause, ±10 s skip, seek bar with buffered range + hover preview
 *  - volume + mute, playback speed, loop, picture-in-picture, fullscreen
 *  - download button, auto-hiding controls, keyboard shortcuts
 *  - transparently refreshes an expired temporary (presigned) URL
 */
export default function VideoPlayer({
  initialUrl,
  poster,
  refreshUrl,
  downloadUrl,
  durationHint,
  className,
  title,
}: VideoPlayerProps) {
  const [src, setSrc] = useState(initialUrl);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() => positiveDuration(durationHint));
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [error, setError] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const dragging = useRef(false);
  const refreshed = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const shouldResume = useRef(false);

  const pipSupported = useSyncExternalStore(
    subscribeNothing,
    getPipSupported,
    getPipUnsupported,
  );

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const bumpActivity = useCallback(() => {
    setShowControls(true);
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused && !dragging.current) setShowControls(false);
    }, HIDE_CONTROLS_DELAY);
  }, [clearHideTimer]);

  const handleActivity = useCallback(() => {
    bumpActivity();
  }, [bumpActivity]);

  const handleMouseLeave = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused && !dragging.current) {
      clearHideTimer();
      setShowControls(false);
    }
  }, [clearHideTimer]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      const result = video.play();
      if (result) result.catch(() => undefined);
    } else {
      video.pause();
    }
  }, []);

  const settlePosition = useCallback((video: HTMLVideoElement, max: number) => {
    const seek = pendingSeek.current;
    pendingSeek.current = null;
    if (seek !== null) {
      const target = max > 0 ? Math.min(Math.max(0, seek), max) : Math.max(0, seek);
      try {
        video.currentTime = target;
      } catch {
        // Ignore — playback continues from the start.
      }
      setCurrentTime(target);
    }
    if (shouldResume.current) {
      shouldResume.current = false;
      const result = video.play();
      if (result) result.catch(() => undefined);
    }
  }, []);

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;
      const real = positiveDuration(video.duration);
      const max = real > 0 ? real : duration;
      const target =
        max > 0
          ? Math.min(Math.max(0, time), max)
          : Math.max(0, time);
      try {
        // Works even while the browser still reports `Infinity` duration.
        video.currentTime = target;
      } catch {
        return;
      }
      setCurrentTime(target);
    },
    [duration],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      seekTo(video.currentTime + delta);
    },
    [seekTo],
  );

  const setPlayerVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(1, Math.max(0, value));
    video.volume = next;
    if (next > 0 && video.muted) video.muted = false;
    setVolume(next);
    setMuted(video.muted);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void container.requestFullscreen().catch(() => undefined);
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // Unsupported or blocked — the button simply does nothing.
    }
  }, []);

  const changeRate = useCallback(
    (value: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = value;
      setRate(value);
      setMenuOpen(false);
      bumpActivity();
    },
    [bumpActivity],
  );

  const toggleLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !video.loop;
    video.loop = next;
    setLoop(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!refreshUrl || refreshed.current >= 3) return false;
    refreshed.current += 1;
    const video = videoRef.current;
    pendingSeek.current = video ? video.currentTime : null;
    shouldResume.current = video ? !video.paused : false;
    try {
      const response = await fetch(refreshUrl, { cache: "no-store" });
      if (!response.ok) return false;
      const data = (await response.json()) as { url?: string };
      if (!data.url) return false;
      setSrc(data.url);
      return true;
    } catch {
      return false;
    }
  }, [refreshUrl]);

  const handleError = useCallback(async () => {
    setWaiting(false);
    const recovered = await refresh();
    if (recovered) {
      videoRef.current?.load();
    } else {
      setError(true);
    }
  }, [refresh]);

  const retry = useCallback(() => {
    setError(false);
    refreshed.current = 0;
    void (async () => {
      const video = videoRef.current;
      if (!video) return;
      const recovered = await refresh();
      if (recovered || !refreshUrl) {
        video.load();
      } else {
        setError(true);
      }
    })();
  }, [refresh, refreshUrl]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const real = positiveDuration(video.duration);
    if (real > 0) {
      setDuration(real);
      settlePosition(video, real);
      return;
    }
    // MediaRecorder WebM files report `Infinity` here. Fall back to the stored
    // length so the seek bar is usable immediately (seeking still works).
    const hint = positiveDuration(durationHint);
    if (hint > 0) {
      setDuration(hint);
      settlePosition(video, hint);
      return;
    }
    settlePosition(video, 0);
  }, [durationHint, settlePosition]);

  const updateBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    let end = 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime + 0.5) {
        end = Math.max(end, video.buffered.end(index));
      }
    }
    setBufferedEnd(end);
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    const real = positiveDuration(video.duration);
    if (real > 0) {
      setDuration((previous) =>
        Math.abs(previous - real) > 0.2 ? real : previous,
      );
    }
    updateBuffered();
  }, [updateBuffered]);

  const handlePlay = useCallback(() => {
    setPlaying(true);
    setWaiting(false);
    bumpActivity();
  }, [bumpActivity]);

  const handlePause = useCallback(() => {
    setPlaying(false);
    setShowControls(true);
    clearHideTimer();
  }, [clearHideTimer]);

  const handleEnded = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      const real = positiveDuration(video.duration);
      const total = real > 0 ? real : video.currentTime;
      if (total > 0) setDuration(total);
    }
    setPlaying(false);
    setShowControls(true);
    clearHideTimer();
  }, [clearHideTimer]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const element = progressRef.current;
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const handleProgressPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = true;
      setShowControls(true);
      const ratio = ratioFromClientX(event.clientX);
      setHoverRatio(ratio);
      const video = videoRef.current;
      const max = positiveDuration(video?.duration) || duration;
      if (max > 0) seekTo(ratio * max);
    },
    [duration, ratioFromClientX, seekTo],
  );

  const handleProgressPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const ratio = ratioFromClientX(event.clientX);
      setHoverRatio(ratio);
      if (!dragging.current) return;
      const video = videoRef.current;
      const max = positiveDuration(video?.duration) || duration;
      if (max > 0) seekTo(ratio * max);
    },
    [duration, ratioFromClientX, seekTo],
  );

  const handleProgressPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = false;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer may already be released.
      }
      bumpActivity();
    },
    [bumpActivity],
  );

  const handleProgressKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        seekBy(-5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        seekBy(5);
      } else if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        seekTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        seekTo(duration);
      }
    },
    [duration, seekBy, seekTo],
  );

  // Sync browser-driven state (fullscreen / picture-in-picture).
  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    };
  }, []);

  // Keyboard shortcuts (Loom-style), ignored while typing in a form field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON" ||
        tag === "A" ||
        target?.isContentEditable
      ) {
        return;
      }
      const video = videoRef.current;
      if (!video) return;

      switch (event.key.toLowerCase()) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
          event.preventDefault();
          seekBy(-5);
          break;
        case "arrowright":
          event.preventDefault();
          seekBy(5);
          break;
        case "j":
          event.preventDefault();
          seekBy(-SKIP_SECONDS);
          break;
        case "l":
          event.preventDefault();
          seekBy(SKIP_SECONDS);
          break;
        case "arrowup":
          event.preventDefault();
          setPlayerVolume(video.volume + 0.1);
          break;
        case "arrowdown":
          event.preventDefault();
          setPlayerVolume(video.volume - 0.1);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "escape":
          setMenuOpen(false);
          break;
        default:
          if (/^[0-9]$/.test(event.key)) {
            const max = positiveDuration(video.duration) || duration;
            if (max > 0) seekTo((Number(event.key) / 10) * max);
          }
      }
      bumpActivity();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bumpActivity,
    duration,
    seekBy,
    seekTo,
    setPlayerVolume,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  ]);

  const percent = (value: number) => {
    if (!duration || !Number.isFinite(duration)) return "0%";
    return `${Math.min(100, Math.max(0, (value / duration) * 100))}%`;
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label={title ?? "Video player"}
      className={classNames(
        "group relative select-none overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        playing && !showControls ? "cursor-none" : "cursor-default",
        className,
      )}
      onMouseMove={handleActivity}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleActivity}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        preload="metadata"
        playsInline
        title={title}
        className="h-full w-full object-contain"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleTimeUpdate}
        onProgress={updateBuffered}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
        onError={() => void handleError()}
      >
        Your browser does not support HTML5 video.
      </video>

      {waiting && !error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/25 border-t-white" />
        </div>
      ) : null}

      {!playing && !waiting && !error ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            togglePlay();
          }}
          aria-label="Play video"
          className="absolute inset-0 flex items-center justify-center bg-black/10 transition hover:bg-black/20"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm transition hover:scale-105 hover:bg-white/25">
            <PlayIcon width={30} height={30} className="ml-1" />
          </span>
        </button>
      ) : null}

      {title ? (
        <div
          className={classNames(
            "pointer-events-none absolute inset-x-0 top-0 bg-linear-to-b from-black/70 to-transparent px-4 pb-10 pt-3 transition-opacity duration-200",
            showControls ? "opacity-100" : "opacity-0",
          )}
        >
          <p className="truncate text-sm font-medium text-white/90">{title}</p>
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
          <AlertIcon width={30} height={30} className="text-amber-400" />
          <p className="max-w-sm text-sm text-white/80">
            This video could not be loaded. The temporary link may have expired.
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
          >
            Try again
          </button>
        </div>
      ) : null}

      <div
        className={classNames(
          "absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-10 transition-opacity duration-200",
          showControls ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          ref={progressRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
          className="group/progress relative mx-0.5 flex h-4 cursor-pointer touch-none items-center"
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          onPointerLeave={() => setHoverRatio(null)}
          onKeyDown={handleProgressKeyDown}
        >
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/25">
            <div
              className="absolute inset-y-0 left-0 bg-white/35"
              style={{ width: percent(bufferedEnd) }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-indigo-500"
              style={{ width: percent(currentTime) }}
            />
          </div>
          <span
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition group-hover/progress:opacity-100"
            style={{ left: percent(currentTime) }}
          />
          {hoverRatio !== null && duration > 0 ? (
            <span
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
              style={{ left: `${hoverRatio * 100}%` }}
            >
              {formatDuration(hoverRatio * duration)}
            </span>
          ) : null}
        </div>

        <div className="mt-0.5 flex items-center gap-1 text-white sm:gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (k)" : "Play (k)"}
            className="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15"
          >
            {playing ? (
              <PauseIcon width={20} height={20} />
            ) : (
              <PlayIcon width={20} height={20} />
            )}
          </button>

          <button
            type="button"
            onClick={() => seekBy(-SKIP_SECONDS)}
            aria-label={`Back ${SKIP_SECONDS} seconds`}
            title={`Back ${SKIP_SECONDS}s (j)`}
            className="hidden h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15 sm:flex"
          >
            <RewindIcon width={18} height={18} />
          </button>
          <button
            type="button"
            onClick={() => seekBy(SKIP_SECONDS)}
            aria-label={`Forward ${SKIP_SECONDS} seconds`}
            title={`Forward ${SKIP_SECONDS}s (l)`}
            className="hidden h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15 sm:flex"
          >
            <ForwardIcon width={18} height={18} />
          </button>

          <div className="ml-1 flex items-center gap-1 text-xs font-medium tabular-nums text-white/80">
            <span>{formatDuration(currentTime)}</span>
            <span className="text-white/40">/</span>
            <span>{formatDuration(duration)}</span>
          </div>

          <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
            <div className="hidden items-center gap-1 sm:flex">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                title={muted ? "Unmute (m)" : "Mute (m)"}
                className="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15"
              >
                {muted || volume === 0 ? (
                  <VolumeMuteIcon width={19} height={19} />
                ) : (
                  <VolumeIcon width={19} height={19} />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(event) => setPlayerVolume(Number(event.target.value))}
                aria-label="Volume"
                className="h-1 w-16 cursor-pointer accent-white"
              />
            </div>

            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="Playback settings"
                aria-expanded={menuOpen}
                title="Playback speed"
                className="flex h-9 items-center rounded-md px-1.5 text-xs font-semibold tabular-nums text-white/90 transition hover:bg-white/15"
              >
                {rate}×
              </button>
              {menuOpen ? (
                <div className="absolute bottom-full right-0 mb-2 w-40 overflow-hidden rounded-lg bg-black/90 py-1 text-sm shadow-xl ring-1 ring-white/10 backdrop-blur">
                  <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-white/50">
                    Playback speed
                  </p>
                  {PLAYBACK_RATES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => changeRate(option)}
                      className={classNames(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left transition hover:bg-white/10",
                        option === rate ? "text-indigo-300" : "text-white/90",
                      )}
                    >
                      {option}×
                      {option === rate ? <CheckIcon width={14} height={14} /> : null}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-white/10" />
                  <button
                    type="button"
                    onClick={toggleLoop}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-white/90 transition hover:bg-white/10"
                    aria-pressed={loop}
                  >
                    <span className="flex items-center gap-2">
                      <LoopIcon width={14} height={14} />
                      Loop video
                    </span>
                    {loop ? <CheckIcon width={14} height={14} /> : null}
                  </button>
                </div>
              ) : null}
            </div>

            {pipSupported ? (
              <button
                type="button"
                onClick={() => void togglePip()}
                aria-label="Picture in picture"
                aria-pressed={pipActive}
                title="Picture in picture"
                className={classNames(
                  "hidden h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15 sm:flex",
                  pipActive && "text-indigo-300",
                )}
              >
                <PipIcon width={18} height={18} />
              </button>
            ) : null}

            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                aria-label="Download video"
                title="Download"
                className="hidden h-9 w-9 items-center justify-center rounded-md text-white transition hover:bg-white/15 sm:flex"
              >
                <DownloadIcon width={18} height={18} />
              </a>
            ) : null}

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              title={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
              className="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-white/15"
            >
              {fullscreen ? (
                <ExitFullscreenIcon width={19} height={19} />
              ) : (
                <FullscreenIcon width={19} height={19} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
