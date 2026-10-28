export const APP_NAME = "SardarIT Loom";
export const APP_DESCRIPTION =
  "Private screen recording studio — record, store, and share your videos.";

export type RecordModeId = "720p" | "1080p" | "1080p-webcam";

export interface RecordMode {
  id: RecordModeId;
  label: string;
  shortLabel: string;
  description: string;
  width: number;
  height: number;
  videoBitsPerSecond: number;
  withWebcam: boolean;
}

/**
 * The three supported recording options. Output is composed onto a canvas of
 * exactly these dimensions, so the reported resolution always matches.
 * Bitrates are chosen for a good quality/size balance with VP9/VP8.
 */
export const RECORD_MODES: RecordMode[] = [
  {
    id: "720p",
    label: "720p HD",
    shortLabel: "720p",
    description: "Screen + microphone. Smaller files, fastest uploads.",
    width: 1280,
    height: 720,
    videoBitsPerSecond: 2_500_000,
    withWebcam: false,
  },
  {
    id: "1080p",
    label: "1080p Full HD",
    shortLabel: "1080p",
    description: "Screen + microphone in full high definition.",
    width: 1920,
    height: 1080,
    videoBitsPerSecond: 4_000_000,
    withWebcam: false,
  },
  {
    id: "1080p-webcam",
    label: "1080p + Webcam",
    shortLabel: "1080p Cam",
    description: "Screen with your webcam in a picture-in-picture bubble.",
    width: 1920,
    height: 1080,
    videoBitsPerSecond: 4_500_000,
    withWebcam: true,
  },
];

export const AUDIO_BITS_PER_SECOND = 128_000;
export const TARGET_FPS = 30;

export function getMode(id: string): RecordMode {
  return RECORD_MODES.find((m) => m.id === id) ?? RECORD_MODES[0];
}
