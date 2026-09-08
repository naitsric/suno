import { NextResponse } from "next/server";
import { z } from "zod";
import { createArtist, listAlbums, listArtists, unassignedSongCount } from "@/lib/artists";

export const dynamic = "force-dynamic";

const Schema = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().max(4).optional(),
  style: z.string().max(1000).optional(),
  description: z.string().max(2000).optional(),
  vocalLanguage: z.string().min(2).max(5).optional(),
});

export async function GET() {
  return NextResponse.json({ artists: listArtists(), albums: listAlbums(), unassignedSongs: unassignedSongCount() });
}

export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
  return NextResponse.json({ artist: createArtist(parsed.data) }, { status: 201 });
}
