import { NextResponse } from "next/server";
import { z } from "zod";
import { getArtist } from "@/lib/artists";
import { analyzeYoutubeReference } from "@/lib/reference";
import { referenceProgress } from "@/lib/voice";
import { artistVoiceBrief } from "@/lib/voices";

export const dynamic = "force-dynamic";

const Schema = z.object({
  url: z.string().url().max(500),
  /** The prompt is written for this artist's default voice (and with their usual style as context). */
  artistId: z.string().nullable().optional(),
  /** Ignore the cached analysis of this video. */
  refresh: z.boolean().default(false),
  /** Client-chosen token to poll `GET /api/reference?token=` while the analysis runs. */
  token: z.string().max(64).optional(),
});

/** Analyses a YouTube reference (voice service) and writes a style prompt from it (Ollama or rules). 1–3 min. */
export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "URL inválida" }, { status: 400 });
  try {
    const artist = parsed.data.artistId ? getArtist(parsed.data.artistId) ?? null : null;
    const result = await analyzeYoutubeReference(parsed.data.url, { voiceBrief: await artistVoiceBrief(artist), artistStyle: artist?.style ?? null, refresh: parsed.data.refresh, token: parsed.data.token });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo analizar la referencia";
    return NextResponse.json({ error: message }, { status: /URL de YouTube|dura|lista sin videos/.test(message) ? 422 : 502 });
  }
}

/** `?token=` → current stage of a running analysis (null when none). */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ stage: null });
  return NextResponse.json(await referenceProgress(token));
}
