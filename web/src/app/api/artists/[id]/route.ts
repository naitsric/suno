import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteArtist, getArtist, updateArtist } from "@/lib/artists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({
  name: z.string().min(1).max(60).optional(),
  emoji: z.string().max(4).optional(),
  style: z.string().max(1000).optional(),
  description: z.string().max(2000).optional(),
  vocalLanguage: z.string().min(2).max(5).optional(),
  defaultVoiceId: z.string().nullable().optional(),
});

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const artist = getArtist(id);
  return artist ? NextResponse.json({ artist }) : NextResponse.json({ error: "No existe" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    return NextResponse.json({ artist: updateArtist(id, parsed.data) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo actualizar" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return deleteArtist(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "No existe" }, { status: 404 });
}
