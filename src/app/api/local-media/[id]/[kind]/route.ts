import { NextRequest, NextResponse } from "next/server";
import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { isLocalMode, localMediaPath } from "@/lib/local-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; kind: string }> }) {
  if (!isLocalMode()) return new NextResponse(null, { status: 404 });
  const { id, kind: rawKind } = await context.params;
  if (rawKind !== "video" && rawKind !== "thumbnail") return new NextResponse(null, { status: 404 });
  const media = await localMediaPath(id, rawKind);
  if (!media) return new NextResponse(null, { status: 404 });
  let info;
  try {
    info = await stat(media.path);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const range = request.headers.get("range");
  const headers = new Headers({
    "Content-Type": media.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (range && rawKind === "video") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new NextResponse(null, { status: 416 });
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : info.size - 1;
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, info.size - suffixLength);
      end = info.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    }
    end = Math.min(end, info.size - 1);
    headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = createReadStream(media.path, { start, end });
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }
  headers.set("Content-Length", String(info.size));
  if (rawKind === "video" && request.nextUrl.searchParams.get("dl") === "1") {
    headers.set("Content-Disposition", `attachment; filename="${media.filename.replaceAll('"', '')}"`);
  }
  if (rawKind === "thumbnail") {
    const handle = await open(media.path, "r");
    const bytes = await handle.readFile();
    await handle.close();
    return new NextResponse(bytes, { headers });
  }
  return new NextResponse(Readable.toWeb(createReadStream(media.path)) as ReadableStream, { headers });
}
