import { NextResponse } from "next/server";
import { z } from "zod";
import { MASTER_PRESETS } from "@/lib/master-presets";
import { postProduce } from "@/lib/songs";

export const dynamic = "force-dynamic";

const Schema = z.object({ preset: z.enum(MASTER_PRESETS).default("off"), enhance: z.boolean().default(false) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Preset inválido" }, { status: 400 });
  try {
    return NextResponse.json({ song: await postProduce(id, parsed.data) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo masterizar" }, { status: 500 });
  }
}
