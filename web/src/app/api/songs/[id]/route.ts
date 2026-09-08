import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSong, getSong, syncPending, updateSongMeta } from "@/lib/songs";
import { assignSong } from "@/lib/artists";

const PatchSchema = z.object({
  title: z.string().max(120).optional(),
  artistId: z.string().nullable().optional(),
  albumId: z.string().nullable().optional(),
});

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await syncPending();
  const song = getSong(id);
  if (!song) return NextResponse.json({ error: "No existe" }, { status: 404 });
  return NextResponse.json({ song });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return deleteSong(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "No existe" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    const current = getSong(id);
    if (!current) return NextResponse.json({ error: "No existe" }, { status: 404 });
    if (parsed.data.artistId !== undefined || parsed.data.albumId !== undefined) {
      const artistId = parsed.data.artistId !== undefined ? parsed.data.artistId : current.artistId;
      const albumId = parsed.data.albumId !== undefined ? parsed.data.albumId : current.albumId;
      assignSong(id, artistId, artistId ? albumId : null);
    }
    if (parsed.data.title !== undefined) updateSongMeta(id, { title: parsed.data.title });
    return NextResponse.json({ song: getSong(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo actualizar" }, { status: 400 });
  }
}
