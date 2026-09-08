import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteAlbum, renameAlbum } from "@/lib/artists";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });
  try {
    return NextResponse.json({ album: renameAlbum(id, parsed.data.name) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo renombrar" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return deleteAlbum(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "No existe" }, { status: 404 });
}
