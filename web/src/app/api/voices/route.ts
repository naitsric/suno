import { NextResponse } from "next/server";
import { ensureVoiceProfiles, listVoices, saveVoice } from "@/lib/voices";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const artist = new URL(req.url).searchParams.get("artist");
  return NextResponse.json({ voices: await ensureVoiceProfiles(listVoices(artist)) });
}

/** multipart/form-data: `audio` (recording or file) + optional `name`. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) return NextResponse.json({ error: "Falta el audio" }, { status: 400 });
    if (audio.size > 50 * 1024 * 1024) return NextResponse.json({ error: "Archivo demasiado grande (máx. 50 MB)" }, { status: 413 });
    const name = String(form.get("name") ?? "").slice(0, 60);
    const artistId = String(form.get("artistId") ?? "").trim() || null;
    const voice = await saveVoice(name, Buffer.from(await audio.arrayBuffer()), audio.name, artistId);
    return NextResponse.json({ voice }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo guardar la voz" }, { status: 500 });
  }
}
