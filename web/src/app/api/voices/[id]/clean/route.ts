import { NextResponse } from "next/server";
import { cleanVoice, getVoice } from "@/lib/voices";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Studio cleanup of the recording (voice service); the original is kept and can be switched back. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!getVoice(id)) return NextResponse.json({ error: "No existe" }, { status: 404 });
  try {
    return NextResponse.json(await cleanVoice(id));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo retocar la voz" }, { status: 502 });
  }
}
