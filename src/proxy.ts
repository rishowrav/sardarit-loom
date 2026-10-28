import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/v", "/api/share", "/api/health"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Next.js proxy (formerly "middleware"): refreshes the Supabase session and
 * enforces single-owner access. Every protected page/API request passes
 * through here; server code still re-verifies auth before touching data.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Local mode uses its own filesystem store and never exposes Supabase/R2
  // data. It is impossible to enable this bypass in production.
  if (process.env.NODE_ENV === "development" && process.env.LOCAL_DEMO_MODE === "true") {
    const hostHeader = request.headers.get("host") ?? "";
    let host = "";
    try {
      host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      // Invalid Host header: deny local unauthenticated mode.
    }
    if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) {
      return new NextResponse("Local development mode only accepts loopback requests.", { status: 403 });
    }
    if (pathname === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/library";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  if (!supabaseConfigured()) {
    if (pathname === "/api/health") return NextResponse.next();
    return new NextResponse(
      "Server is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const isAllowed =
    Boolean(user) &&
    (!ownerEmail || user?.email?.toLowerCase() === ownerEmail);

  if (user && !isAllowed) {
    // A session exists but belongs to a different account: sign it out.
    await supabase.auth.signOut();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "?error=account";
    return NextResponse.redirect(url);
  }

  if (!isAllowed && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isAllowed && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/library";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
