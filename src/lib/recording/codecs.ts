/**
 * Codec negotiation: pick the best container/codec combination the current
 * browser actually supports, in order of preference. VP9 → VP8 → H.264 →
 * generic fallbacks keep the app working across Chrome, Edge, Firefox and
 * Safari (where MediaRecorder emits MP4).
 */

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=h264,opus",
  "video/webm",
  "video/mp4",
] as const;

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // isTypeSupported can throw on exotic strings — keep trying
    }
  }
  return null;
}

export interface SupportCheck {
  supported: boolean;
  /**
   * True when getDisplayMedia is available. When false the recorder still
   * works using the camera as the video source (embedded previews / browsers
   * without screen capture permission).
   */
  screenSupported: boolean;
  reason?: string;
}

/**
 * Capability check run before showing the recorder UI. Screen capture needs
 * a secure context (HTTPS or localhost) and the MediaRecorder API.
 */
export function checkRecordingSupport(): SupportCheck {
  if (typeof window === "undefined") {
    return { supported: false, screenSupported: false, reason: "Client-side only." };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      screenSupported: false,
      reason:
        "Screen recording requires HTTPS (or http://localhost). Open the app over a secure origin.",
    };
  }
  if (typeof MediaRecorder === "undefined") {
    return {
      supported: false,
      screenSupported: false,
      reason: "This browser does not support MediaRecorder.",
    };
  }

  const screenSupported =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const cameraSupported =
    typeof navigator.mediaDevices?.getUserMedia === "function";

  if (!screenSupported && !cameraSupported) {
    return {
      supported: false,
      screenSupported: false,
      reason: "This browser supports neither screen nor camera capture.",
    };
  }
  if (!screenSupported && cameraSupported) {
    // Screen capture isn't exposed here (common on mobile browsers). Recording
    // still works via the camera, but full-screen capture needs desktop Chrome.
    return {
      supported: true,
      screenSupported: false,
      reason:
        "Screen capture isn't available here (common on mobile browsers). Full-screen recording needs desktop Chrome or Edge; camera recording still works.",
    };
  }
  if (!pickMimeType()) {
    return {
      supported: false,
      screenSupported,
      reason: "No supported video codec was found in this browser.",
    };
  }
  return { supported: true, screenSupported };
}

let supportCache: SupportCheck | null = null;

/**
 * Cached capability check with a stable return identity — safe to use as a
 * `useSyncExternalStore` snapshot (capability never changes per session, and
 * `null` signals "not checked yet" during SSR/hydration).
 */
export function getCachedRecordingSupport(): SupportCheck | null {
  if (typeof window === "undefined") return null;
  supportCache ??= checkRecordingSupport();
  return supportCache;
}
