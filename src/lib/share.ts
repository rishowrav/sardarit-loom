import { randomBytes } from "node:crypto";

/**
 * URL-safe share token: 32 random bytes (256 bits) — unguessable, so the
 * link itself is the capability.
 */
export function createShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function shareUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/v/${token}`;
}
