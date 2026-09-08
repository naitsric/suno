import { NextResponse } from "next/server";
import { z } from "zod";
import { getVoice, sculptVoice } from "@/lib/voices";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  /** Formant shift in % of vocal-tract size: negative = bigger and darker, positive = smaller and brighter. */
  formant: z.number().min(-30).max(30).default(0),
  /** Pitch median shift in semitones. */
  pitch: z.number().min(-12).max(12).default(0),
  /** High-shelf gain at 3 kHz in dB ("air"). */
  brightness: z.number().min(-12).max(12).default(0),
});

/** Sculpts the timbre of the reference (voice service, Praat); the unsculpted reference is kept and can be switched back. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!getVoice(id)) return NextResponse.json({ error: "No existe" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  try {
    return NextResponse.json(await sculptVoice(id, parsed.data));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo esculpir la voz" }, { status: 502 });
  }
}
