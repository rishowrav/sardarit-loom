import Link from "next/link";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import RecordingCard from "@/components/RecordingCard";
import ResumeUploadsBanner from "@/components/ResumeUploadsBanner";
import SearchBar from "@/components/SearchBar";
import { RecordIcon } from "@/components/icons";
import { APP_NAME } from "@/lib/config";
import { getServerEnv, isLocalDemoMode } from "@/lib/env";
import { localFileUrl, localListRecordings, localUsage } from "@/lib/local-store";
import { presignGet } from "@/lib/r2";
import { getOwnerContext } from "@/lib/supabase/auth";
import type { Recording } from "@/lib/types";
import { toIlikePattern } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface LibraryPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const q = ((await searchParams).q ?? "").trim();

  if (isLocalDemoMode()) {
    const rows = (await localListRecordings()).filter((row) => row.title.toLowerCase().includes(q.toLowerCase()));
    const usage = await localUsage();
    const cards = rows.map((row) => ({
      row,
      thumbnailUrl: row.status === "completed" && row.thumbnail_key ? localFileUrl(row.id, "thumbnail") : null,
    }));
    return (
      <AppShell email="Local development" localDemo usage={{ usedBytes: usage.usedBytes, limitBytes: usage.limitBytes }}>
        <LibraryContent query={q} rows={rows} cards={cards} />
      </AppShell>
    );
  }

  const ctx = await getOwnerContext();
  if (!ctx) redirect("/login");

  const env = getServerEnv();

  let query = ctx.supabase
    .from("recordings")
    .select("*")
    .order("created_at", { ascending: false });
  if (q) query = query.ilike("title", toIlikePattern(q));

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load recordings: ${error.message}`);
  }

  const rows = (data ?? []) as Recording[];
  const usedBytes = rows
    .filter((row) => row.status === "completed")
    .reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0);

  const cards = await Promise.all(
    rows.map(async (row) => {
      if (row.status !== "completed" || !row.thumbnail_key) {
        return { row, thumbnailUrl: null as string | null };
      }
      try {
        const thumbnailUrl = await presignGet(row.thumbnail_key, {
          expiresIn: env.presignTtlSeconds,
        });
        return { row, thumbnailUrl };
      } catch {
        return { row, thumbnailUrl: null };
      }
    }),
  );

  return (
    <AppShell
      email={ctx.user.email ?? ""}
      usage={{ usedBytes, limitBytes: env.storageLimitBytes }}
    >
      <LibraryContent query={q} rows={rows} cards={cards} />
    </AppShell>
  );
}

function LibraryContent({ query: q, rows, cards }: {
  query: string;
  rows: Recording[];
  cards: { row: Recording; thumbnailUrl: string | null }[];
}) {
  const completedCount = cards.filter((card) => card.row.status === "completed").length;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Library
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {completedCount === 0 && rows.length === 0
              ? "No recordings yet."
              : `${completedCount} video${completedCount === 1 ? "" : "s"}${
                  rows.length > completedCount
                    ? `, ${rows.length - completedCount} pending`
                    : ""
                }`}
          </p>
        </div>
        <div className="flex w-full items-center gap-3 sm:w-auto">
          <SearchBar initial={q} />
          <Link
            href="/record"
            className="flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
          >
            <RecordIcon width={15} height={15} />
            New recording
          </Link>
        </div>
      </div>

      <ResumeUploadsBanner />

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <RecordIcon width={22} height={22} />
          </span>
          {q ? (
            <>
              <p className="text-sm font-medium text-slate-700">
                No recordings match “{q}”.
              </p>
              <a
                href="/library"
                className="mt-2 inline-block text-sm font-medium text-indigo-600 hover:underline"
              >
                Clear search
              </a>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-slate-900">
                Record your first video
              </h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
                Capture your screen with microphone audio in 720p or 1080p,
                then share a private link.
              </p>
              <Link
                href="/record"
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
              >
                <RecordIcon width={15} height={15} />
                Start recording
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ row, thumbnailUrl }) => (
            <RecordingCard
              key={row.id}
              recording={row}
              thumbnailUrl={thumbnailUrl}
            />
          ))}
        </div>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        {APP_NAME} — private by design: bucket stays locked, links are temporary.
      </footer>
    </>
  );
}

