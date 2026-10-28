/**
 * Server-side environment access with validation.
 *
 * Only ever imported from server code (route handlers, server components,
 * proxy). Values other than NEXT_PUBLIC_* must never be referenced from
 * client components — that would leak secrets into the browser bundle.
 */

const MISSING: string[] = [];

/** Local filesystem mode is available only on the loopback development server. */
export function isLocalDemoMode(): boolean {
  return process.env.NODE_ENV === "development" && process.env.LOCAL_DEMO_MODE === "true";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    MISSING.push(name);
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolEnv(name: string): boolean {
  const raw = optional(name)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return parsed;
}

export interface R2Env {
  endpoint: string;
  /** SigV4 region — "auto" for Cloudflare R2; must match the bucket region for Backblaze B2. */
  region: string;
  /** Path-style URLs (`endpoint/bucket/key`) for stores that dislike virtual-hosted. */
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface ServerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  ownerEmail: string | undefined;
  r2: R2Env;
  storageLimitBytes: number;
  chunkSizeBytes: number;
  presignTtlSeconds: number;
}

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  // Any S3-compatible store works: explicit endpoint (Backblaze B2, MinIO, …)
  // or Cloudflare R2 derived from the account id.
  let endpoint = optional("R2_ENDPOINT");
  if (!endpoint) {
    const accountId = required("R2_ACCOUNT_ID");
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  const gb = positiveInt("STORAGE_LIMIT_GB", 20);
  const mb = positiveInt("CHUNK_SIZE_MB", 8);

  const env: ServerEnv = {
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    ownerEmail: optional("OWNER_EMAIL")?.toLowerCase(),
    r2: {
      endpoint,
      region: optional("R2_REGION") ?? "auto",
      forcePathStyle: boolEnv("R2_FORCE_PATH_STYLE"),
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      bucket: required("R2_BUCKET"),
    },
    storageLimitBytes: gb * 1024 * 1024 * 1024,
    chunkSizeBytes: mb * 1024 * 1024,
    presignTtlSeconds: positiveInt("PRESIGN_TTL_SECONDS", 21_600),
  };

  // R2 multipart uploads require >= 5 MB parts (except the final one).
  if (env.chunkSizeBytes < 5 * 1024 * 1024) {
    throw new Error("CHUNK_SIZE_MB must be at least 5 (R2 multipart minimum).");
  }

  cached = env;
  return env;
}

/** For build-time / diagnostics: which integrations are configured (booleans only). */
export function envStatus(): {
  supabase: boolean;
  r2: boolean;
  ownerEmail: boolean;
  storageLimitGb: number;
} {
  return {
    supabase: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
    r2: Boolean(
      (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID) &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET,
    ),
    ownerEmail: Boolean(process.env.OWNER_EMAIL),
    storageLimitGb: positiveInt("STORAGE_LIMIT_GB", 20),
  };
}

export function missingEnvNames(): string[] {
  return [...new Set(MISSING)];
}
