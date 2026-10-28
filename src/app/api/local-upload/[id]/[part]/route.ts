import { NextRequest, NextResponse } from "next/server";
import { isLocalMode, localGetRecording, localStorePart } from "@/lib/local-store";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string; part: string }> }) {
  if (!isLocalMode()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { id, part: rawPart } = await context.params;
  const part = Number(rawPart);
  const recording = await localGetRecording(id);
  if (!recording || recording.status !== "uploading") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!Number.isInteger(part) || part < 1 || part > 10000) return NextResponse.json({ error: "invalid_part" }, { status: 400 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  await localStorePart(id, part, bytes);
  return new NextResponse(null, { status: 200, headers: { ETag: `"local-${part}-${bytes.byteLength}"` } });
}
