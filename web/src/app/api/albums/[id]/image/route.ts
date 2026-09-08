import fs from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { albumImagePath, generateAlbumImage, getAlbum, getArtist, suggestAlbumImagePrompt } from "@/lib/artists";
import { openaiConfigured } from "@/lib/openai-images";
import { listSongs } from "@/lib/songs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** `?suggest` → {prompt, configured}; otherwise the stored cover PNG. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const album = getAlbum(id);
  if (!album) return NextResponse.json({ error: "No existe" }, { status: 404 });
  if (new URL(req.url).searchParams.has("suggest")) {
    const titles = [...new Set(listSongs({ artistId: album.artistId }).filter((s) => s.albumId === id).map((s) => s.title))];
    return NextResponse.json({ prompt: album.imagePrompt ?? suggestAlbumImagePrompt(album, getArtist(album.artistId), titles), configured: openaiConfigured() });
  }
  const file = albumImagePath(album);
  if (!file || !fs.existsSync(file)) return NextResponse.json({ error: "Sin imagen" }, { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
}

/** Generates the cover from a prompt with the OpenAI image API. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = z.object({ prompt: z.string().min(5).max(4000), quality: z.enum(["low", "medium", "high"]).default("medium") }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Prompt inválido" }, { status: 400 });
  try {
    return NextResponse.json({ album: await generateAlbumImage(id, parsed.data.prompt, parsed.data.quality) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo generar la portada" }, { status: 502 });
  }
}
