import { NextResponse, type NextRequest } from "next/server";
import { envStatus } from "@/lib/env";
import { isCapExceeded, probeStorageRead } from "@/lib/r2";
import { isLocalMode, localUsage } from "@/lib/local-store";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated diagnostics: reports WHICH integrations are configured
 * (booleans only — never values or keys). Handy to verify setup before
 * logging in.
 *
 * `?check=storage` additionally performs one cheap read against the bucket.
 * Writes (uploads) work even when Backblaze's daily transaction cap is
 * exhausted, so this is the only reliable way to tell why videos fail to
 * play while uploads still succeed.
 */
export async function GET(request: NextRequest) {
  if (isLocalMode()) {
    const storage = await localUsage();
    return NextResponse.json({ ok: true, app: "SardarIT Loom", mode: "local", storage });
  }
  const status = envStatus();
  const base = {
    ok: status.supabase && status.r2,
    app: "SardarIT Loom",
    env: status,
  };

  if (request.nextUrl.searchParams.get("check") !== "storage") {
    return NextResponse.json(base);
  }

  try {
    await probeStorageRead();
    return NextResponse.json({ ...base, storage: { readable: true, capExceeded: false } });
  } catch (error) {
    const capExceeded = isCapExceeded(error);
    return NextResponse.json(
      {
        ...base,
        storage: {
          readable: false,
          capExceeded,
          hint: capExceeded
            ? "Backblaze daily transaction cap exhausted. Raise it in Backblaze → Caps & Alerts (or wait until 00:00 GMT). Uploads keep working; playback needs a read transaction."
            : error instanceof Error
              ? error.message
              : "Storage read failed",
        },
      },
      { status: capExceeded ? 503 : 500 },
    );
  }
}
