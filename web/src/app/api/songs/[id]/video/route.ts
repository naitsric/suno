import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSong, startVideo } from "@/lib/songs";

export const dynamic = "force-dynamic";

const AUDIO_DIR = process.env.AUDIO_DIR ?? "./data/audio";

/** Starts (or restarts) the stills video of a finished song. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { subtitles?: boolean; provider?: "openai" | "local" };
  try {
    return NextResponse.json({ song: await startVideo(id, { subtitles: body.subtitles !== false, provider: body.provider }) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo crear el video" }, { status: 400 });
  }
}

/** Streams the rendered MP4 with Range support so the <video> element can seek. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const song = getSong(id);
  if (!song?.videoFile) return NextResponse.json({ error: "Sin video" }, { status: 404 });
  const file = path.join(AUDIO_DIR, song.videoFile);
  if (!fs.existsSync(file)) return NextResponse.json({ error: "Sin video" }, { status: 404 });
  const size = fs.statSync(file).size;
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  const download = new URL(req.url).searchParams.has("download");
  const base: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" };
  if (download) base["content-disposition"] = `attachment; filename="${song.title.replace(/[^\w. -]+/g, "_")}.mp4"`;
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    const buf = Buffer.alloc(end - start + 1);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return new Response(buf, { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(buf.length) } });
  }
  return new Response(fs.readFileSync(file), { headers: { ...base, "content-length": String(size) } });
}
