"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Recording } from "@/lib/types";
import {
  classNames,
  formatDate,
  formatBytes,
  formatDuration,
  resolutionLabel,
} from "@/lib/utils";
import VideoPlayer from "./VideoPlayer";
import { useToast } from "./toast";
import {
  AlertIcon,
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  FilmIcon,
  LinkIcon,
  PencilIcon,
  TrashIcon,
} from "./icons";

interface RecordingDetailProps {
  recording: Recording;
  playbackUrl: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
}

export default function RecordingDetail({
  recording,
  playbackUrl,
  downloadUrl,
  thumbnailUrl,
}: RecordingDetailProps) {
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(recording.title);
  const [busy, setBusy] = useState<
    "rename" | "delete" | "share-create" | "share-toggle" | "share-revoke" | null
  >(null);

  const sharePath = recording.share_token
    ? `/v/${recording.share_token}`
    : null;

  async function saveTitle() {
    const title = draftTitle.trim();
    if (!title) return;
    setBusy("rename");
    try {
      const response = await fetch(`/api/recordings/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error("Rename failed");
      setEditing(false);
      toast.push("Renamed.", "success");
      router.refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Rename failed", "error");
      setDraftTitle(recording.title);
      setEditing(false);
    } finally {
      setBusy(null);
    }
  }

  async function deleteRecording() {
    if (
      !window.confirm(
        `Delete “${recording.title}” permanently? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy("delete");
    try {
      const response = await fetch(`/api/recordings/${recording.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          details?: string;
        };
        throw new Error(data.details ?? "Delete failed");
      }
      toast.push("Recording deleted.", "success");
      router.push("/library");
      router.refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Delete failed", "error");
      setBusy(null);
    }
  }

  async function createShare() {
    setBusy("share-create");
    try {
      const response = await fetch(`/api/recordings/${recording.id}/share`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Could not create the share link");
      toast.push("Share link created.", "success");
      router.refresh();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "Could not create the link",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggleShare(enabled: boolean) {
    setBusy("share-toggle");
    try {
      const response = await fetch(`/api/recordings/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareEnabled: enabled }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          details?: string;
        };
        throw new Error(data.details ?? "Update failed");
      }
      toast.push(
        enabled ? "Shared link enabled." : "Shared link disabled.",
        "success",
      );
      router.refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Update failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function revokeShare() {
    if (
      !window.confirm(
        "Revoke the share link? The current URL will stop working forever.",
      )
    ) {
      return;
    }
    setBusy("share-revoke");
    try {
      const response = await fetch(`/api/recordings/${recording.id}/share`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Revoke failed");
      toast.push("Share link revoked.", "success");
      router.refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Revoke failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function copyShare() {
    if (!sharePath) return;
    const fullUrl = `${window.location.origin}${sharePath}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast.push("Link copied.", "success");
    } catch {
      toast.push(`Copy failed — ${fullUrl}`, "error");
    }
  }

  return (
    <div>
      <Link
        href="/library"
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeftIcon width={16} height={16} />
        Library
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          {recording.status !== "completed" ? (
            <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-6">
              <div className="flex items-start gap-2">
                <AlertIcon width={18} height={18} className="mt-0.5 text-amber-600" />
                <div>
                  <h2 className="text-sm font-semibold text-amber-900">
                    This upload is unfinished
                  </h2>
                  <p className="mt-1 text-sm text-amber-800">
                    Resume or discard it from the banner on the library page.
                  </p>
                </div>
              </div>
              <Link
                href="/library"
                className="mt-4 inline-block rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-500"
              >
                Go to library
              </Link>
            </div>
          ) : playbackUrl ? (
            <VideoPlayer
              key={recording.id}
              initialUrl={playbackUrl}
              poster={thumbnailUrl}
              refreshUrl={`/api/recordings/${recording.id}/playback`}
              downloadUrl={downloadUrl}
              durationHint={recording.duration_seconds}
              title={recording.title}
              className="aspect-video w-full rounded-xl bg-black shadow-sm ring-1 ring-slate-200"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500 ring-1 ring-slate-200">
              <span className="flex items-center gap-2">
                <FilmIcon width={18} height={18} />
                Playback link unavailable — try reloading.
              </span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {editing ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTitle();
                }}
                className="flex flex-1 items-center gap-2"
              >
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  maxLength={200}
                  className="min-w-0 flex-1 rounded-lg border border-indigo-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-100"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setEditing(false);
                      setDraftTitle(recording.title);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={busy === "rename"}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraftTitle(recording.title);
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-slate-900">
                  {recording.title}
                </h1>
                <button
                  type="button"
                  onClick={() => {
                    setDraftTitle(recording.title);
                    setEditing(true);
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                >
                  <PencilIcon width={14} height={14} />
                  Rename
                </button>
                <a
                  href={downloadUrl ?? "#"}
                  download
                  aria-disabled={!downloadUrl}
                  onClick={(event) => {
                    if (!downloadUrl) event.preventDefault();
                  }}
                  className={classNames(
                    "flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white transition",
                    downloadUrl
                      ? "bg-indigo-600 hover:bg-indigo-500"
                      : "cursor-not-allowed bg-slate-300",
                  )}
                >
                  <DownloadIcon width={15} height={15} />
                  Download
                </a>
              </>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Details</h2>
            <dl className="space-y-2.5 text-sm">
              <DetailRow label="Duration" value={formatDuration(recording.duration_seconds)} />
              <DetailRow
                label="Resolution"
                value={resolutionLabel(recording.width, recording.height)}
              />
              <DetailRow label="Size" value={formatBytes(recording.size_bytes)} />
              <DetailRow label="Recorded" value={formatDate(recording.created_at)} />
              <DetailRow
                label="Format"
                value={(recording.mime_type ?? "—").replace("video/", "").toUpperCase()}
              />
              <DetailRow
                label="Status"
                value={
                  recording.status === "completed" ? "Uploaded" : "Unfinished"
                }
              />
            </dl>
          </section>

          <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <div className="mb-1 flex items-center gap-2">
              <LinkIcon width={15} height={15} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-900">Share link</h2>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              Anyone with the link can watch without signing in. Disable or
              revoke it at any time — private videos are never listable.
            </p>

            {!recording.share_token ? (
              <button
                type="button"
                onClick={() => void createShare()}
                disabled={busy === "share-create" || recording.status !== "completed"}
                className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
              >
                {busy === "share-create" ? "Creating…" : "Create share link"}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-1.5">
                  <input
                    readOnly
                    value={sharePath ?? ""}
                    onFocus={(event) => event.target.select()}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-600 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void copyShare()}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <CopyIcon width={13} height={13} />
                    Copy
                  </button>
                </div>

                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5">
                  <span className="text-sm text-slate-700">
                    Link{" "}
                    <strong
                      className={classNames(
                        recording.share_enabled ? "text-emerald-600" : "text-slate-400",
                      )}
                    >
                      {recording.share_enabled ? "enabled" : "disabled"}
                    </strong>
                  </span>
                  <span className="relative inline-flex">
                    <input
                      type="checkbox"
                      checked={recording.share_enabled}
                      disabled={busy === "share-toggle"}
                      onChange={(event) => void toggleShare(event.target.checked)}
                      className="peer sr-only"
                    />
                    <span
                      className={classNames(
                        "h-5 w-9 rounded-full transition",
                        recording.share_enabled ? "bg-emerald-500" : "bg-slate-300",
                        "after:absolute after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all",
                        recording.share_enabled
                          ? "after:left-[18px]"
                          : "after:left-0.5",
                      )}
                    />
                  </span>
                </label>

                <button
                  type="button"
                  onClick={() => void revokeShare()}
                  disabled={busy === "share-revoke"}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                >
                  <TrashIcon width={13} height={13} />
                  {busy === "share-revoke" ? "Revoking…" : "Revoke link"}
                </button>
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
            <button
              type="button"
              onClick={() => void deleteRecording()}
              disabled={busy === "delete"}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
            >
              <TrashIcon width={15} height={15} />
              {busy === "delete" ? "Deleting…" : "Delete recording"}
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-slate-800">{value}</dd>
    </div>
  );
}
