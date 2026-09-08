import fs from "node:fs";
import { NextResponse } from "next/server";
import { audioPathFor, getSong } from "@/lib/songs";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const song = getSong(id);
  const url = new URL(req.url);
  const file = song ? (url.searchParams.has("raw") && song.rawAudioFile ? audioPathFor({ ...song, audioFile: song.rawAudioFile }) : audioPathFor(song, url.searchParams.has("original"))) : null;
  if (!song || !file || !fs.existsSync(file)) return NextResponse.json({ error: "Audio no disponible" }, { status: 404 });

  const size = fs.statSync(file).size;
  const ext = file.split(".").pop() ?? "mp3";
  const type = MIME[ext] ?? "application/octet-stream";
  const download = new URL(req.url).searchParams.has("download");
  const baseHeaders: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    ...(download ? { "content-disposition": `attachment; filename="${song.title.replace(/[^\w\- ]+/g, "")}.${ext}"` } : {}),
  };

  const range = req.headers.get("range");
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    const stream = fs.createReadStream(file, { start, end });
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(fs.createReadStream(file) as unknown as ReadableStream, { headers: { ...baseHeaders, "content-length": String(size) } });
}
