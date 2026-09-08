import { NextResponse } from "next/server";
import { health, listModels } from "@/lib/acestep";
import { ollamaAvailable } from "@/lib/ollama";
import { health as voiceHealth } from "@/lib/voice";

export const dynamic = "force-dynamic";

export async function GET() {
  const [h, models, ollama, v] = await Promise.all([health(), listModels(), ollamaAvailable(), voiceHealth()]);
  return NextResponse.json({
    engine: { online: !!h, version: h?.version ?? null, models: models?.models ?? [], defaultModel: models?.default_model ?? null },
    ollama: { online: ollama, model: process.env.OLLAMA_MODEL ?? null },
    voice: { online: !!v, device: v?.device ?? null, modelsLoaded: v?.models_loaded ?? false },
  });
}
