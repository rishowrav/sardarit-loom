"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Recording } from "@/lib/types";
import { classNames, formatDateShort, formatDuration, formatBytes } from "@/lib/utils";
import { useToast } from "./toast";
import {
  CopyIcon,
  DownloadIcon,
  FilmIcon,
  LinkIcon,
  PencilIcon,
  PlayIcon,
  TrashIcon,
} from "./icons";

interface RecordingCardProps {
  recording: Recording;
  thumbnailUrl: string | null;
}

export default function RecordingCard({ recording, thumbnailUrl }: RecordingCardProps) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(recording.title);
  const [busy, setBusy] = useState<"rename" | "delete" | "discard" | "download" | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  const pending = recording.status === "uploading";

  async function saveTitle() {
    const title = draftTitle.trim();
    if (!title || title === recording.title) {
      setEditing(false);
      setDraftTitle(recording.title);
      return;
    }
    setBusy("rename");
    try {
      const response = await fetch(`/api/recordings/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { details?: string };
        throw new Error(data.details ?? "Rename failed");
      }
      setEditing(false);
      toast.push("Recording renamed.", "success");
      router.refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Rename failed", "error");
      setDraftTitle(recording.title);
      setEditing(false);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    try {
      const response = await fetch(
        `/api/recordings/${recording.id}/playback?dl=1`,
      );
      if (!response.ok) throw new Error("Could not prepare the download");
      const data = (await response.json()) as { url: string };
      const anchor = document.createElement("a");
      anchor.href = data.url;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "Download failed",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
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
        const data = (await response.json().catch(() => ({}))) as { details?: string };
        throw new Error(data.details ?? "Delete failed");
      }
      toast.push("Recording deleted.", "success");
      router.refresh();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "Delete failed",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function discardPending() {
    if (
      !window.confirm(
        "Discard this unfinished upload? The recorded video will be lost.",
      )
    ) {
      return;
    }
    setBusy("discard");
    try {
      const response = await fetch(`/api/uploads/${recording.id}/abort`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Discard failed");
      toast.push("Unfinished upload discarded.", "info");
      router.refresh();
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "Discard failed",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function copyShareLink() {
    if (!recording.share_token) return;
    const url = `${window.location.origin}/v/${recording.share_token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push("Share link copied.", "success");
    } catch {
      toast.push(`Copy failed — ${url}`, "error");
    }
  }

  if (pending) {
    return (
      <article className="flex flex-col rounded-xl border border-dashed border-slate-300 bg-white p-4">
        <div className="mb-3 flex h-32 items-center justify-center rounded-lg bg-slate-50">
          <FilmIcon width={28} height={28} className="text-slate-300" />
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-700">
              {recording.title}
            </p>
            <p className="mt-0.5 text-xs text-amber-600">
              Upload unfinished — resume it from the banner above.
            </p>
          </div>
          <button
            type="button"
            onClick={discardPending}
            disabled={busy === "discard"}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
          >
            {busy === "discard" ? "Discarding…" : "Discard"}
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
      <Link
        href={`/recordings/${recording.id}`}
        className="relative block aspect-video bg-slate-100"
        aria-label={`Open ${recording.title}`}
      >
        {thumbnailUrl && !thumbFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <FilmIcon width={32} height={32} className="text-slate-300" />
          </div>
        )}
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
          {formatDuration(recording.duration_seconds)}
        </span>
        <span className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-slate-800 opacity-0 shadow-md transition group-hover:opacity-100">
          <PlayIcon width={18} height={18} />
        </span>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
            className="flex gap-1.5"
          >
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={200}
              className="min-w-0 flex-1 rounded-md border border-indigo-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-100"
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
              className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy === "rename" ? "…" : "Save"}
            </button>
          </form>
        ) : (
          <Link
            href={`/recordings/${recording.id}`}
            className="line-clamp-2 text-sm font-medium text-slate-900 hover:text-indigo-700"
          >
            {recording.title}
          </Link>
        )}

        <p className="text-xs text-slate-500">
          {formatDateShort(recording.created_at)} ·{" "}
          {formatBytes(recording.size_bytes)}
        </p>

        <div className="mt-auto flex items-center gap-1 pt-1 text-slate-400">
          <ActionButton
            label="Rename"
            busy={busy === "rename"}
            onClick={() => {
              setDraftTitle(recording.title);
              setEditing(true);
            }}
          >
            <PencilIcon width={15} height={15} />
          </ActionButton>
          <ActionButton label="Download" busy={busy === "download"} onClick={() => void download()}>
            <DownloadIcon width={15} height={15} />
          </ActionButton>
          {recording.share_token ? (
            <ActionButton
              label={recording.share_enabled ? "Copy share link" : "Copy link (disabled)"}
              busy={false}
              onClick={() => void copyShareLink()}
            >
              {recording.share_enabled ? (
                <LinkIcon width={15} height={15} />
              ) : (
                <CopyIcon width={15} height={15} />
              )}
            </ActionButton>
          ) : null}
          <span className="ml-auto" />
          <ActionButton
            label="Delete"
            busy={busy === "delete"}
            danger
            onClick={() => void remove()}
          >
            <TrashIcon width={15} height={15} />
          </ActionButton>
        </div>
      </div>
    </article>
  );
}

function ActionButton({
  label,
  onClick,
  busy,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={busy}
      className={classNames(
        "rounded-md p-1.5 transition hover:bg-slate-100 disabled:opacity-40",
        danger ? "hover:bg-red-50 hover:text-red-600" : "hover:text-slate-700",
      )}
    >
      {children}
    </button>
  );
}
