import { NextResponse } from "next/server";
import { z } from "zod";
import { draftSong, ollamaAvailable } from "@/lib/ollama";
import { formatInput } from "@/lib/acestep";
import { analyzeVoice, getVoice, voiceProfile, voiceRegister } from "@/lib/voices";
import { voiceBrief } from "@/lib/voice-register";

export const dynamic = "force-dynamic";

const Schema = z.object({
  description: z.string().min(3).max(2000),
  language: z.string().default("es"),
  instrumental: z.boolean().default(false),
  /** Voice that will sing it: the draft is written for its register, range and timbre. */
  voiceId: z.string().nullable().optional(),
});

/** Writes title/style/lyrics from a description (Ollama first, ACE-Step LM as fallback). */
export async function POST(req: Request) {
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Descripción inválida" }, { status: 400 });
  try {
    if (await ollamaAvailable()) {
      let voice: string | null = null;
      let v = parsed.data.voiceId && !parsed.data.instrumental ? getVoice(parsed.data.voiceId) : undefined;
      if (v) {
        if (v.profile === null) v = await analyzeVoice(v);
        const register = voiceRegister(v);
        if (register) voice = voiceBrief(register, voiceProfile(v));
      }
      return NextResponse.json({ draft: await draftSong({ ...parsed.data, voice }), source: "ollama" });
    }
    const out = await formatInput(parsed.data.description, "", parsed.data.language);
    return NextResponse.json({
      draft: { title: parsed.data.description.slice(0, 40), style: out.caption ?? "", lyrics: out.lyrics ?? "" },
      source: "acestep",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo generar la letra" }, { status: 502 });
  }
}
