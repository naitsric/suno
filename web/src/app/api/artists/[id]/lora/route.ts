import { NextResponse } from "next/server";
import { z } from "zod";
import { artistLoraStatus, startArtistLora, stopArtistLora } from "@/lib/lora";

export const dynamic = "force-dynamic";

const Schema = z.object({ epochs: z.number().int().min(1).max(200).optional(), rank: z.number().int().min(4).max(256).optional(), minSongs: z.number().int().min(1).max(50).optional() });

/** Trains an ACE-Step LoRA on the artist's finished songs (background; poll GET). See lib/lora.ts. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    return NextResponse.json({ artist: startArtistLora(id, parsed.data) }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo entrenar" }, { status: 400 });
  }
}

/** Training state: DB status/progress plus the engine's live counters while it trains. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await artistLoraStatus(id));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No existe" }, { status: 404 });
  }
}

/** Stops a running training. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ artist: await stopArtistLora(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo parar" }, { status: 400 });
  }
}
