import { NextResponse } from "next/server";
import { z } from "zod";
import { editSong, planSongEdit } from "@/lib/songs";

export const dynamic = "force-dynamic";

const PlanSchema = z.object({
  op: z.enum(["cover", "repaint"]),
  style: z.string().max(1000),
  lyrics: z.string().max(8000),
  strength: z.number().min(0.3).max(1),
  start: z.number().min(0).nullable(),
  end: z.number().min(-1).nullable(),
  summary: z.string().max(500),
});

const Schema = z.object({
  instruction: z.string().min(2).max(1000),
  start: z.number().min(0).nullable().optional(),
  end: z.number().min(0).nullable().optional(),
  /** Omit to only get the plan back; send the (possibly edited) plan to run it. */
  plan: PlanSchema.optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Instrucción inválida" }, { status: 400 });
  try {
    if (!parsed.data.plan) {
      const plan = await planSongEdit(id, parsed.data.instruction, { start: parsed.data.start ?? null, end: parsed.data.end ?? null });
      return NextResponse.json({ plan });
    }
    const songs = await editSong(id, parsed.data.instruction, parsed.data.plan);
    return NextResponse.json({ songs }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo editar" }, { status: 502 });
  }
}
