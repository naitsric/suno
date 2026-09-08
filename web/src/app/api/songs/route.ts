import { NextResponse } from "next/server";
import { z } from "zod";
import { createSong, listSongs, syncPending } from "@/lib/songs";
import { MASTER_PRESETS } from "@/lib/master-presets";
import { ConversionOptionsSchema } from "@/lib/voice-options";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  mode: z.enum(["simple", "custom"]),
  title: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  style: z.string().max(1000).optional(),
  lyrics: z.string().max(8000).optional(),
  instrumental: z.boolean().default(false),
  duration: z.number().min(10).max(600).nullable().optional(),
  vocalLanguage: z.string().min(2).max(5).default("es"),
  model: z.string().nullable().optional(),
  voiceId: z.string().nullable().optional(),
  autotune: z.boolean().default(false),
  /** Conversion quality knobs (see lib/voice-options.ts); omitted = service defaults. */
  voiceOptions: ConversionOptionsSchema.nullable().optional(),
  master: z.enum(MASTER_PRESETS).default("off"),
  artistId: z.string().nullable().optional(),
  albumId: z.string().nullable().optional(),
  /** Measured on a reference song: passed to the engine as fixed metadata instead of letting its LM guess. */
  bpm: z.number().int().min(30).max(300).nullable().optional(),
  keyScale: z.string().max(20).nullable().optional(),
});

/** `?artist=<id>` filters by artist, `?artist=none` lists songs without artist. */
export async function GET(req: Request) {
  await syncPending();
  const artist = new URL(req.url).searchParams.get("artist");
  return NextResponse.json({ songs: listSongs(artist === null ? {} : { artistId: artist === "none" ? null : artist }) });
}

export async function POST(req: Request) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }
  try {
    const created = await createSong(parsed.data);
    return NextResponse.json({ songs: created }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error creando la canción";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
