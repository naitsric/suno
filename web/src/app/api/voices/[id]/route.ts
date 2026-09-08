import fs from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { REGISTERS } from "@/lib/voice-register";
import { deleteVoice, getVoice, setUseClean, setUseSculpt, updateVoice, voiceOriginalPath, voicePath, voiceSculptPath, voiceSourcePath } from "@/lib/voices";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Streams the active reference (`?original` forces the raw recording, `?clean` the cleaned one, `?sculpt` the sculpted one). */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const v = getVoice(id);
  if (!v) return NextResponse.json({ error: "No existe" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const file = q.has("original") ? voiceOriginalPath(v) : q.has("clean") && v.cleanFile ? voiceSourcePath({ ...v, useClean: true }) : q.has("sculpt") ? voiceSculptPath(v) : voicePath(v);
  if (!file || !fs.existsSync(file)) return NextResponse.json({ error: "No existe" }, { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return deleteVoice(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "No existe" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = z.object({ name: z.string().max(60).optional(), artistId: z.string().nullable().optional(), register: z.enum(REGISTERS).optional(), useClean: z.boolean().optional(), useSculpt: z.boolean().optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    const { useClean, useSculpt, ...rest } = parsed.data;
    let voice = updateVoice(id, rest);
    if (useClean !== undefined) voice = await setUseClean(id, useClean);
    if (useSculpt !== undefined) voice = await setUseSculpt(id, useSculpt);
    return NextResponse.json({ voice });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo actualizar" }, { status: 400 });
  }
}
