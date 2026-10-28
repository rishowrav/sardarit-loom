import { NextResponse } from "next/server";
import { envStatus } from "@/lib/env";
import { isLocalMode, localUsage } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated diagnostics: reports WHICH integrations are configured
 * (booleans only — never values or keys). Handy to verify setup before
 * logging in.
 */
export async function GET() {
  if (isLocalMode()) {
    const storage = await localUsage();
    return NextResponse.json({ ok: true, app: "SardarIT Loom", mode: "local", storage });
  }
  const status = envStatus();
  return NextResponse.json({
    ok: status.supabase && status.r2,
    app: "SardarIT Loom",
    env: status,
  });
}
