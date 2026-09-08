import { NextResponse } from "next/server";
import { z } from "zod";
import { reconvertVoice, removeVoice } from "@/lib/songs";
import { ConversionOptionsSchema } from "@/lib/voice-options";

export const dynamic = "force-dynamic";

const Schema = z.object({ autotune: z.boolean().optional(), voiceId: z.string().min(1).optional(), options: ConversionOptionsSchema.nullable().optional() });

/**
 * Re-converts the song's vocals with the current voice settings (autotune on/off, cleaned reference) and,
 * optionally, quality knobs (`options`: diffusionSteps, cfgRate, refDenoise, refSeconds, glueSpectrumDb,
 * glueReverb, enhanceVocals, deharshDb). `options: null` returns to the service defaults; omitted keeps the stored ones.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    return NextResponse.json({ song: reconvertVoice(id, parsed.data) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo reconvertir" }, { status: 400 });
  }
}

/** Removes the converted vocals: the song goes back to the voice the model sang with. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ song: removeVoice(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo quitar la voz" }, { status: 400 });
  }
}
