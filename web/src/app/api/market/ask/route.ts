import { NextResponse } from "next/server";
import { z } from "zod";
import { getArtist } from "@/lib/artists";
import { getMarketSnapshot } from "@/lib/market";
import { askMarket } from "@/lib/market-ideas";
import { ollamaAvailable } from "@/lib/ollama";
import { artistVoiceBrief } from "@/lib/voices";

export const dynamic = "force-dynamic";

const Schema = z.object({ country: z.string().min(2).max(2).default("co"), artistId: z.string().nullable().optional(), question: z.string().min(3).max(1000) });

export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Pregunta inválida" }, { status: 400 });
  try {
    if (!(await ollamaAvailable())) return NextResponse.json({ error: "Ollama está apagado: las preguntas necesitan el LLM local." }, { status: 503 });
    const snapshot = await getMarketSnapshot(parsed.data.country.toLowerCase());
    const artist = parsed.data.artistId ? getArtist(parsed.data.artistId) ?? null : null;
    return NextResponse.json({ answer: await askMarket(snapshot, artist, parsed.data.question, await artistVoiceBrief(artist)) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo responder" }, { status: 502 });
  }
}
