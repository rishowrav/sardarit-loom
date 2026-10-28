import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getOwnerContext, type AuthContext } from "@/lib/supabase/auth";

export function jsonError(
  status: number,
  error: string,
  details?: string,
): NextResponse {
  return NextResponse.json(
    details ? { error, details } : { error },
    { status },
  );
}

export const unauthorized = () => jsonError(401, "unauthorized");
export const forbidden = () => jsonError(403, "forbidden");
export const notFound = (resource = "resource") =>
  jsonError(404, `${resource} not found`);

/**
 * Auth guard for API routes: returns either the signed-in owner's context or
 * a ready-to-return error response.
 */
export async function requireOwner(): Promise<
  { ok: true; ctx: AuthContext } | { ok: false; response: NextResponse }
> {
  const ctx = await getOwnerContext();
  if (!ctx) return { ok: false, response: unauthorized() };
  return { ok: true, ctx };
}

/** Parse a JSON body with a zod schema, mapping failures to a 400 response. */
export function parseBody<T>(
  body: unknown,
  schema: ZodType<T>,
): { ok: true; data: T } | { ok: false; response: NextResponse } {
  try {
    return { ok: true, data: schema.parse(body) };
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const message = first
        ? `${first.path.join(".") || "body"}: ${first.message}`
        : "invalid body";
      return { ok: false, response: jsonError(400, "invalid_request", message) };
    }
    return { ok: false, response: jsonError(400, "invalid_request") };
  }
}

export function serverErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Second argument for route handlers under a `[id]` segment. */
export type IdParams = { params: Promise<{ id: string }> };
