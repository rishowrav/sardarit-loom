import { NextRequest, NextResponse } from "next/server";
import { isLocalMode, localGetRecording, localSaveThumbnail } from "@/lib/local-store";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isLocalMode()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { id } = await context.params;
  const row = await localGetRecording(id);
  if (!row || row.status !== "uploading") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 5 * 1024 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413 });
  await localSaveThumbnail(id, bytes);
  return new NextResponse(null, { status: 204 });
}
