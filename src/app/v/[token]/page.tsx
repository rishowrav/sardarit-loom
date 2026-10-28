import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import VideoPlayer from "@/components/VideoPlayer";
import { RecordIcon } from "@/components/icons";
import { APP_NAME } from "@/lib/config";
import { getServerEnv } from "@/lib/env";
import { isLocalMode, localFileUrl, localFindShared } from "@/lib/local-store";
import { presignGet } from "@/lib/r2";
import { createSupabaseServer } from "@/lib/supabase/server";
import { formatDate, formatDuration, resolutionLabel } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

async function loadShared(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  if (isLocalMode()) return localFindShared(token);
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.rpc("get_shared_recording", {
    p_token: token,
  });
  if (error || !data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as Record<string, unknown> | undefined) ?? null;
}

export async function generateMetadata({
  params,
}: SharePageProps): Promise<Metadata> {
  const { token } = await params;
  const row = await loadShared(token);
  if (!row) return { title: "Shared recording" };
  return {
    title: (row.title as string) ?? "Shared recording",
    robots: { index: false, follow: false },
  };
}

export default async function SharedRecordingPage({ params }: SharePageProps) {
  const { token } = await params;
  const row = await loadShared(token);
  if (!row) notFound();

  let playbackUrl: string | null = null;
  let thumbnailUrl: string | null = null;
  if (isLocalMode()) {
    playbackUrl = localFileUrl(row.id as string, "video");
    thumbnailUrl = row.thumbnail_key ? localFileUrl(row.id as string, "thumbnail") : null;
  } else {
    const env = getServerEnv();
    try {
      const [cloudPlaybackUrl, cloudThumbnailUrl] = await Promise.all([
        presignGet(row.r2_key as string, { expiresIn: env.presignTtlSeconds }),
        row.thumbnail_key
          ? presignGet(row.thumbnail_key as string, {
              expiresIn: env.presignTtlSeconds,
            })
          : Promise.resolve(null),
      ]);
      playbackUrl = cloudPlaybackUrl;
      thumbnailUrl = cloudThumbnailUrl;
    } catch {
      // Player will surface an error state.
    }
  }

  const title = (row.title as string) ?? "Shared recording";
  const createdAt = row.created_at as string;

  return (
    <div className="flex min-h-full flex-1 flex-col bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-white">
            <RecordIcon width={12} height={12} />
          </span>
          <span className="text-sm font-semibold text-slate-900">{APP_NAME}</span>
          <span className="ml-auto text-xs text-slate-400">
            Shared recording — no sign-in needed
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:py-10">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          {title}
        </h1>
        <p className="mb-5 text-sm text-slate-500">
          {formatDate(createdAt)} · {formatDuration(row.duration_seconds as number | null)}
          {" · "}
          {resolutionLabel(row.width as number | null, row.height as number | null)}
        </p>

        {playbackUrl ? (
          <VideoPlayer
            initialUrl={playbackUrl}
            poster={thumbnailUrl}
            refreshUrl={`/api/share/${token}`}
            title={title}
            className="aspect-video w-full rounded-xl bg-black shadow-md ring-1 ring-slate-300"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-white text-sm text-slate-500 ring-1 ring-slate-200">
            This video is temporarily unavailable.
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 text-xs text-slate-400">
          <span>
            © {new Date().getFullYear()} {APP_NAME}
          </span>
          <Link href="/login" className="hover:text-slate-600">
            Owner sign-in
          </Link>
        </div>
      </footer>
    </div>
  );
}
