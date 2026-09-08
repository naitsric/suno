import { NextResponse } from "next/server";
import { getVoice, measureVoice } from "@/lib/voices";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Re-measures the pitch and timbre profile of a voice with the voice service. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const v = getVoice(id);
  if (!v) return NextResponse.json({ error: "No existe" }, { status: 404 });
  try {
    return NextResponse.json({ voice: await measureVoice(v) });
  } catch (err) {
    return NextResponse.json({ error: `No se pudo analizar (¿está encendido el servicio de voz?): ${err instanceof Error ? err.message : err}` }, { status: 502 });
  }
}
