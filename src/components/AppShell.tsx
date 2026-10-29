"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { classNames, formatBytes } from "@/lib/utils";
import { APP_NAME } from "@/lib/config";
import { FilmIcon, HardDriveIcon, LogoutIcon, RecordIcon } from "./icons";
import { ToastProvider } from "./toast";

interface AppShellProps {
  email: string;
  usage?: { usedBytes: number; limitBytes: number } | null;
  localDemo?: boolean;
  children: ReactNode;
}

const NAV_ITEMS = [
  { href: "/library", label: "Library", icon: FilmIcon },
  { href: "/record", label: "Record", icon: RecordIcon },
  { href: "/settings", label: "Settings", icon: HardDriveIcon },
] as const;

export default function AppShell({ email, usage, localDemo = false, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (localDemo) return;
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowser();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const percent =
    usage && usage.limitBytes > 0
      ? Math.min(100, Math.round((usage.usedBytes / usage.limitBytes) * 100))
      : 0;
  const nearLimit = percent >= 90;

  return (
    <ToastProvider>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/library" className="flex items-center" aria-label={APP_NAME}>
            <Image
              src="/sardarit-loom-logo.png"
              alt={APP_NAME}
              width={1362}
              height={441}
              priority
              className="h-11 w-auto"
            />
          </Link>

          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={classNames(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-slate-100 text-slate-900"
                      : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            {localDemo ? <span className="hidden rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 sm:inline">Local storage</span> : null}
            {usage ? (
              <div className="hidden items-center gap-2 md:flex" title={`${percent}% of storage used`}>
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={classNames(
                      "h-full rounded-full transition-all",
                      nearLimit ? "bg-amber-500" : "bg-emerald-500",
                    )}
                    style={{ width: `${Math.max(2, percent)}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500">
                  {formatBytes(usage.usedBytes)} / {formatBytes(usage.limitBytes)}
                </span>
              </div>
            ) : null}

            <span className="hidden text-sm text-slate-500 sm:inline">{email}</span>
            {!localDemo ? <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            >
              <LogoutIcon width={16} height={16} />
              <span className="hidden sm:inline">
                {signingOut ? "Signing out…" : "Sign out"}
              </span>
            </button> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </ToastProvider>
  );
}
