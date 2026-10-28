import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import RecordingDetail from "@/components/RecordingDetail";
import { getServerEnv, isLocalDemoMode } from "@/lib/env";
import { localFileUrl, localGetRecording, localUsage } from "@/lib/local-store";
import { presignGet } from "@/lib/r2";
import { getOwnerContext } from "@/lib/supabase/auth";
import type { Recording } from "@/lib/types";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  if (isLocalDemoMode()) {
    const row = await localGetRecording(id);
    return { title: row?.title ?? "Recording" };
  }
  const ctx = await getOwnerContext();
  if (!ctx) return { title: "Recording" };
  const { data } = await ctx.supabase
    .from("recordings")
    .select("title")
    .eq("id", id)
    .maybeSingle();
  return { title: (data as { title?: string } | null)?.title ?? "Recording" };
}

export default async function RecordingDetailPage({ params }: DetailPageProps) {
  const { id } = await params;
  if (isLocalDemoMode()) {
    const recording = await localGetRecording(id);
    if (!recording) notFound();
    const usage = await localUsage();
    return (
      <AppShell email="Local development" localDemo usage={{ usedBytes: usage.usedBytes, limitBytes: usage.limitBytes }}>
        <RecordingDetail
          recording={recording}
          playbackUrl={recording.status === "completed" ? localFileUrl(id, "video") : null}
          downloadUrl={recording.status === "completed" ? `${localFileUrl(id, "video")}?dl=1` : null}
          thumbnailUrl={recording.thumbnail_key ? localFileUrl(id, "thumbnail") : null}
        />
      </AppShell>
    );
  }

  const ctx = await getOwnerContext();
  if (!ctx) redirect("/login");

  const { data, error } = await ctx.supabase
    .from("recordings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load recording: ${error.message}`);
  if (!data) notFound();

  const recording = data as Recording;
  const env = getServerEnv();

  let playbackUrl: string | null = null;
  let downloadUrl: string | null = null;
  let thumbnailUrl: string | null = null;

  if (recording.status === "completed") {
    try {
      [playbackUrl, downloadUrl, thumbnailUrl] = await Promise.all([
        presignGet(recording.r2_key, { expiresIn: env.presignTtlSeconds }),
        presignGet(recording.r2_key, {
          expiresIn: env.presignTtlSeconds,
          downloadFilename: `${recording.title}.webm`,
        }),
        recording.thumbnail_key
          ? presignGet(recording.thumbnail_key, {
              expiresIn: env.presignTtlSeconds,
            })
          : Promise.resolve(null),
      ]);
    } catch {
      // URLs stay null → UI shows a playback error state.
    }
  }

  const { data: usageRows } = await ctx.supabase
    .from("recordings")
    .select("size_bytes")
    .eq("status", "completed");
  const usedBytes = (usageRows ?? []).reduce(
    (sum, row) => sum + (Number(row.size_bytes) || 0),
    0,
  );

  return (
    <AppShell
      email={ctx.user.email ?? ""}
      usage={{ usedBytes, limitBytes: env.storageLimitBytes }}
    >
      <RecordingDetail
        recording={recording}
        playbackUrl={playbackUrl}
        downloadUrl={downloadUrl}
        thumbnailUrl={thumbnailUrl}
      />
    </AppShell>
  );
}
