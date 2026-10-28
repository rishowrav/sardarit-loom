export type RecordingStatus = "uploading" | "completed" | "failed";

/** Row shape of `public.recordings` (camelCase on the client). */
export interface Recording {
  id: string;
  owner_id: string;
  title: string;
  status: RecordingStatus;
  share_token: string | null;
  share_enabled: boolean;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  r2_key: string;
  thumbnail_key: string | null;
  upload_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** Recording plus server-generated, time-limited URLs for rendering. */
export interface RecordingWithUrls extends Recording {
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
}

export interface StorageSummary {
  usedBytes: number;
  limitBytes: number;
  completedCount: number;
}

export interface InitiateUploadResponse {
  recordingId: string;
  chunkSizeBytes: number;
  partCount: number;
}

export interface SignPartsResponse {
  parts: { partNumber: number; url: string }[];
}

export interface CompleteUploadResponse {
  recordingId: string;
  sizeBytes: number;
  storage: StorageSummary;
  cleanup: { deletedCount: number; freedBytes: number; errors: string[] };
}

export interface ApiErrorBody {
  error: string;
  details?: string;
}
