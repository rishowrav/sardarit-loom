import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import CleanupButton from "@/components/CleanupButton";
import { AlertIcon, CheckIcon, HardDriveIcon, MicIcon, MonitorIcon } from "@/components/icons";
import { envStatus, getServerEnv, isLocalDemoMode } from "@/lib/env";
import { localUsage } from "@/lib/local-store";
import { getOwnerContext } from "@/lib/supabase/auth";
import { classNames, formatBytes } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  if (isLocalDemoMode()) {
    const usage = await localUsage();
    return (
      <AppShell email="Local development" localDemo usage={{ usedBytes: usage.usedBytes, limitBytes: usage.limitBytes }}>
        <div className="mx-auto max-w-2xl space-y-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h1>
            <p className="mt-1 text-sm text-slate-500">Local development configuration.</p>
          </div>
          <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Local storage</h2>
            <p className="mt-2 text-sm text-slate-600">Videos, thumbnails and recording metadata are stored on this machine in <code>data/local</code>.</p>
            <p className="mt-2 text-xs text-slate-500">{usage.completedCount} saved recording(s) · {formatBytes(usage.usedBytes)} used of {formatBytes(usage.limitBytes)}</p>
          </section>
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            Local mode skips login only in development and uses no Supabase or R2 data. This mode cannot be enabled by a production build.
          </section>
        </div>
      </AppShell>
    );
  }

  const ctx = await getOwnerContext();
  if (!ctx) redirect("/login");

  const env = getServerEnv();
  const { data } = await ctx.supabase
    .from("recordings")
    .select("size_bytes, status")
    .in("status", ["completed", "uploading"]);
  const rows = data ?? [];
  const completed = rows.filter((row) => row.status === "completed");
  const pendingCount = rows.length - completed.length;
  const usedBytes = completed.reduce(
    (sum, row) => sum + (Number(row.size_bytes) || 0),
    0,
  );
  const percent =
    env.storageLimitBytes > 0
      ? Math.min(100, (usedBytes / env.storageLimitBytes) * 100)
      : 0;

  const status = envStatus();

  return (
    <AppShell
      email={ctx.user.email ?? ""}
      usage={{ usedBytes, limitBytes: env.storageLimitBytes }}
    >
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Settings
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Storage, account and configuration status for this single-user app.
          </p>
        </div>

        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <div className="mb-4 flex items-center gap-2">
            <HardDriveIcon width={17} height={17} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-900">Storage</h2>
          </div>

          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-700">
              {formatBytes(usedBytes)}{" "}
              <span className="font-normal text-slate-400">
                of {formatBytes(env.storageLimitBytes)}
              </span>
            </span>
            <span className="tabular-nums text-slate-500">
              {percent.toFixed(1)}%
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={classNames(
                "h-full rounded-full",
                percent >= 90 ? "bg-amber-500" : "bg-emerald-500",
              )}
              style={{ width: `${Math.max(1.5, percent)}%` }}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {completed.length} completed video{completed.length === 1 ? "" : "s"}
              {pendingCount > 0
                ? ` · ${pendingCount} unfinished upload${pendingCount === 1 ? "" : "s"} (never auto-deleted)`
                : ""}
            </p>
            <CleanupButton />
          </div>

          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
            When the limit is reached (after an upload), the oldest completed
            recordings are removed first to free space. Active or incomplete
            uploads are never deleted automatically.
          </p>
        </section>

        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Account</h2>
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">Signed in as</dt>
              <dd className="truncate font-medium text-slate-800">
                {ctx.user.email}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-slate-500">Access</dt>
              <dd className="font-medium text-slate-800">
                Single owner (matches OWNER_EMAIL)
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">
            Configuration status
          </h2>
          <ul className="space-y-2.5 text-sm">
            <StatusRow
              ok={status.supabase}
              label="Supabase (auth + database)"
              hint={
                status.supabase ? "Connected" : "Set NEXT_PUBLIC_SUPABASE_URL and KEY"
              }
            />
            <StatusRow
              ok={status.r2}
              label="Cloudflare R2 (storage)"
              hint={status.r2 ? "Credentials present" : "Set R2_* variables"}
            />
            <StatusRow
              ok={status.ownerEmail}
              label="Owner email"
              hint={
                status.ownerEmail
                  ? "Only the owner can sign in"
                  : "Set OWNER_EMAIL to lock the app to one account"
              }
            />
          </ul>
          <p className="mt-4 flex items-start gap-1.5 text-xs text-slate-400">
            <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
            Values live in environment variables — see <code>.env.example</code>{" "}
            for the full list. Secret keys are never sent to the browser.
          </p>
        </section>

        <section className="flex flex-wrap gap-4 rounded-2xl bg-white p-5 text-xs text-slate-500 ring-1 ring-slate-200">
          <span className="inline-flex items-center gap-1.5">
            <MonitorIcon width={14} height={14} className="text-slate-400" />
            Recording: 720p / 1080p / 1080p + webcam
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MicIcon width={14} height={14} className="text-slate-400" />
            Codec auto-selected (VP9 → VP8 → H.264 fallback)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CheckIcon width={14} height={14} className="text-emerald-500" />
            Chunked, resumable uploads
          </span>
        </section>
      </div>
    </AppShell>
  );
}

function StatusRow({
  ok,
  label,
  hint,
}: {
  ok: boolean;
  label: string;
  hint: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={classNames(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600",
        )}
      >
        {ok ? (
          <CheckIcon width={10} height={10} />
        ) : (
          <AlertIcon width={10} height={10} />
        )}
      </span>
      <span>
        <span className="font-medium text-slate-800">{label}</span>
        <span className="ml-2 text-xs text-slate-500">{hint}</span>
      </span>
    </li>
  );
}
