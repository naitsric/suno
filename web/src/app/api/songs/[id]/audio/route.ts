import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { audioPathFor, getSong } from "@/lib/songs";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg", aac: "audio/aac", m4a: "audio/mp4" };

/**
 * `?format=wav`: 24-bit PCM WAV at the file's own sample rate (48 kHz from ACE-Step), the delivery format
 * distributors ask for. Transcoded per request into a temp file that is unlinked as soon as it is opened
 * (~50 MB per song, not worth caching next to the MP3s). It is a lossless container for the MP3, not more detail.
 */
async function wav24(file: string, filename: string) {
  const tmp = path.join(os.tmpdir(), `suno-${randomUUID()}.wav`);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vn", "-c:a", "pcm_s24le", tmp]);
  } catch {
    fs.rmSync(tmp, { force: true });
    return NextResponse.json({ error: "No se pudo exportar a WAV" }, { status: 500 });
  }
  const fd = fs.openSync(tmp, "r");
  const size = fs.fstatSync(fd).size;
  fs.rmSync(tmp);
  return new Response(fs.createReadStream("", { fd }) as unknown as ReadableStream, {
    headers: { "content-type": "audio/wav", "content-length": String(size), "content-disposition": `attachment; filename="${filename}.wav"`, "cache-control": "no-store" },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const song = getSong(id);
  const url = new URL(req.url);
  const file = song ? (url.searchParams.has("raw") && song.rawAudioFile ? audioPathFor({ ...song, audioFile: song.rawAudioFile }) : audioPathFor(song, url.searchParams.has("original"))) : null;
  if (!song || !file || !fs.existsSync(file)) return NextResponse.json({ error: "Audio no disponible" }, { status: 404 });

  const filename = song.title.replace(/[^\w\- ]+/g, "");
  if (url.searchParams.get("format") === "wav") return wav24(file, filename);

  const size = fs.statSync(file).size;
  const ext = file.split(".").pop() ?? "mp3";
  const type = MIME[ext] ?? "application/octet-stream";
  const download = url.searchParams.has("download");
  const baseHeaders: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    ...(download ? { "content-disposition": `attachment; filename="${filename}.${ext}"` } : {}),
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
