"use client";

import { useCallback, useRef, useState } from "react";

interface VideoPlayerProps {
  initialUrl: string;
  poster?: string | null;
  /** Endpoint returning `{ url }` again when the temporary link expires. */
  refreshUrl?: string;
  className?: string;
  title?: string;
}

/**
 * HTML5 player that transparently refreshes its temporary (presigned) URL if
 * playback fails mid-session — viewers never notice the rotation.
 */
export default function VideoPlayer({
  initialUrl,
  poster,
  refreshUrl,
  className,
  title,
}: VideoPlayerProps) {
  const [src, setSrc] = useState(initialUrl);
  const videoRef = useRef<HTMLVideoElement>(null);
  const refreshedRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!refreshUrl || refreshedRef.current >= 3) return false;
    refreshedRef.current += 1;
    try {
      const response = await fetch(refreshUrl, { cache: "no-store" });
      if (!response.ok) return false;
      const data = (await response.json()) as { url?: string };
      if (!data.url) return false;
      setSrc(data.url);
      return true;
    } catch {
      return false;
    }
  }, [refreshUrl]);

  const handleError = useCallback(async () => {
    const recovered = await refresh();
    if (recovered) videoRef.current?.load();
  }, [refresh]);

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster ?? undefined}
      controls
      preload="metadata"
      playsInline
      onError={handleError}
      className={className}
      title={title}
    >
      Your browser does not support HTML5 video.
    </video>
  );
}
