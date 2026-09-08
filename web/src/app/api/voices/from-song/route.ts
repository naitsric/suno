import { NextResponse } from "next/server";
import { z } from "zod";
import { createVoiceFromSong } from "@/lib/voices";

export const dynamic = "force-dynamic";

const Schema = z.object({ songId: z.string().min(1), name: z.string().max(60).optional() });

/** Creates a sung reference voice (synthetic singer) from a generated song and makes it the artist's default. */
export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    return NextResponse.json(await createVoiceFromSong(parsed.data.songId, parsed.data.name), { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo crear la voz" }, { status: 502 });
  }
}
