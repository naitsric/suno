import { NextResponse } from "next/server";
import { health, listModels } from "@/lib/acestep";
import { ollamaAvailable } from "@/lib/ollama";
import { health as voiceHealth } from "@/lib/voice";
import { health as videoHealth } from "@/lib/video";

export const dynamic = "force-dynamic";

export async function GET() {
  const [h, models, ollama, v, vid] = await Promise.all([health(), listModels(), ollamaAvailable(), voiceHealth(), videoHealth()]);
  return NextResponse.json({
    engine: { online: !!h, version: h?.version ?? null, models: models?.models ?? [], defaultModel: models?.default_model ?? null },
    ollama: { online: ollama, model: process.env.OLLAMA_MODEL ?? null },
    voice: { online: !!v, device: v?.device ?? null, modelsLoaded: v?.models_loaded ?? false },
    video: { online: !!vid, device: vid?.device ?? null, freeGb: vid?.free_gb ?? null, busy: vid?.busy ?? false },
  });
}
