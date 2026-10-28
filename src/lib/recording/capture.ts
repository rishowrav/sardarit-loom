/**
 * Permission-aware capture helpers. Every getUserMedia/getDisplayMedia
 * failure is translated into a typed error so the UI can offer the right
 * recovery (retry, continue without mic/webcam, or abort).
 */

export type CaptureErrorCode =
  | "insecure"
  | "unsupported"
  | "screen_denied"
  | "screen_unavailable"
  | "screen_track_ended"
  | "mic_denied"
  | "mic_missing"
  | "webcam_denied"
  | "webcam_missing"
  | "unknown";

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

function mapMediaError(
  error: unknown,
  kind: "screen" | "mic" | "webcam" | "camera",
): CaptureError {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);

  if (kind === "screen") {
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new CaptureError(
        "screen_denied",
        "Screen sharing was blocked. Allow screen access and try again.",
      );
    }
    if (name === "NotFoundError" || name === "NotReadableError") {
      return new CaptureError(
        "screen_unavailable",
        "No screen or window was available to share.",
      );
    }
    if (name === "NotSupportedError" || name === "TypeError") {
      return new CaptureError(
        "unsupported",
        "This browser cannot capture the screen.",
      );
    }
    return new CaptureError("unknown", message || "Screen capture failed.");
  }

  if (kind === "mic") {
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new CaptureError(
        "mic_denied",
        "Microphone access was blocked. Allow microphone access or continue without audio.",
      );
    }
    if (
      name === "NotFoundError" ||
      name === "OverconstrainedError" ||
      name === "DevicesNotFoundError"
    ) {
      return new CaptureError(
        "mic_missing",
        "No microphone was found. Connect one or continue without audio.",
      );
    }
    return new CaptureError("unknown", message || "Microphone setup failed.");
  }

  if (kind === "camera") {
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new CaptureError(
        "webcam_denied",
        "Camera access was blocked — allow camera access to record without screen capture.",
      );
    }
    if (
      name === "NotFoundError" ||
      name === "OverconstrainedError" ||
      name === "DevicesNotFoundError"
    ) {
      return new CaptureError(
        "webcam_missing",
        "No camera was found — screen capture is also unavailable in this browser.",
      );
    }
    return new CaptureError("unknown", message || "Camera setup failed.");
  }

  // webcam
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new CaptureError(
      "webcam_denied",
      "Camera access was blocked. Allow camera access or continue without the webcam.",
    );
  }
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  ) {
    return new CaptureError(
      "webcam_missing",
      "No camera was found. Continue without the webcam.",
    );
  }
  return new CaptureError("unknown", message || "Camera setup failed.");
}

/** True when the browser exposes screen capture (missing inside some iframes). */
export function hasDisplayCapture(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/** Requests the screen/tab to share, including optional system audio. */
export async function captureDisplay(
  width: number,
  height: number,
): Promise<MediaStream> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    throw new CaptureError("unsupported", "Screen capture is not supported here.");
  }

  // Progressive constraint fallback: some browsers reject the Chrome-specific
  // hints (systemAudio/selfBrowserSurface/monitorTypeSurfaces) or the audio
  // request, which previously turned into a silent camera fallback. Try the
  // richest constraints first, then simpler ones, only giving up when every
  // attempt fails.
  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
      audio: true,
      // @ts-expect-error - Chrome-specific hint, harmless elsewhere
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "include",
    },
    {
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
      audio: true,
    },
    {
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
      audio: false,
    },
    { video: true, audio: false },
  ];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (error) {
      lastError = error;
      // Only retry on constraint/unsupported-style failures; permission
      // denials and "no surface" errors should surface immediately.
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      if (
        name === "NotAllowedError" ||
        name === "SecurityError" ||
        name === "NotFoundError" ||
        name === "NotReadableError"
      ) {
        throw mapMediaError(error, "screen");
      }
    }
  }
  throw mapMediaError(lastError, "screen");
}

/**
 * Camera video source used when screen capture is unavailable (embedded
 * preview frames, browsers without display-capture permission). The
 * compositor renders it exactly like a screen share, so recording,
 * pause/resume, upload and playback all behave the same.
 */
export async function captureCamera(
  width: number,
  height: number,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("unsupported", "Camera capture is not supported here.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
  } catch (error) {
    throw mapMediaError(error, "camera");
  }
}

export async function captureMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("unsupported", "Microphone capture is not supported here.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    throw mapMediaError(error, "mic");
  }
}

export async function captureWebcam(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("unsupported", "Camera capture is not supported here.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
  } catch (error) {
    throw mapMediaError(error, "webcam");
  }
}

export function isCaptureError(error: unknown, code: CaptureErrorCode): boolean {
  return error instanceof CaptureError && error.code === code;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
