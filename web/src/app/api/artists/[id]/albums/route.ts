import { NextResponse } from "next/server";
import { z } from "zod";
import { createAlbum, listAlbums } from "@/lib/artists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return NextResponse.json({ albums: listAlbums(id) });
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
  try {
    return NextResponse.json({ album: createAlbum(id, parsed.data.name) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo crear" }, { status: 400 });
  }
}
