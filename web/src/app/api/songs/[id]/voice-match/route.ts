import { NextResponse } from "next/server";
import { z } from "zod";
import { requestVoiceMatch } from "@/lib/songs";

export const dynamic = "force-dynamic";

const Schema = z.object({ voiceId: z.string().min(1) });

/**
 * Scores how much the song's (unconverted) singer sounds like a voice: `songs.voiceSimilarity` is filled on a
 * later poll of `GET /api/songs` (Demucs + CAMPPlus in the voice service, ~30 s). Lets you keep the generation
 * that already sounds like the artist instead of converting it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Falta voiceId" }, { status: 400 });
  try {
    return NextResponse.json({ song: requestVoiceMatch(id, parsed.data.voiceId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo medir" }, { status: 400 });
  }
}
