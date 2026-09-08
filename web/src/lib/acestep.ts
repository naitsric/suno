/**
 * Thin client for the ACE-Step 1.5 REST API (engine/run.sh, port 8001).
 * Docs: https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md
 */
const BASE = (process.env.ACESTEP_URL ?? "http://127.0.0.1:8001").replace(/\/$/, "");

type Envelope<T> = { data: T; code: number; error: string | null; timestamp?: number };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, cache: "no-store" });
  const text = await res.text();
  let body: Envelope<T> | undefined;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(`ACE-Step ${path} respondió ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (body.code && body.code !== 200)) {
    throw new Error(body.error ?? `ACE-Step ${path} respondió ${res.status}`);
  }
  return body.data;
}

export type EngineHealth = { status: string; service: string; version: string; models_initialized?: boolean; llm_initialized?: boolean; loaded_model?: string | null; loaded_lm_model?: string | null };
export type EngineModel = { name: string; is_default?: boolean };

export async function health(): Promise<EngineHealth | null> {
  try {
    return await call<EngineHealth>("/health");
  } catch {
    return null;
  }
}

export async function listModels(): Promise<{ models: EngineModel[]; default_model: string | null } | null> {
  try {
    // The server answers in OpenAI style ({object:"list", data:[{id, name}]}) or wrapped ({data:{models, default_model}}).
    const res = await fetch(`${BASE}/v1/models`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const d = body.data;
    if (Array.isArray(d)) {
      const models = d.map((m: { id?: string; name?: string }) => ({ name: (m.id ?? m.name ?? "").replace(/^acestep\//, "") })).filter((m) => m.name);
      const h = await health();
      return { models, default_model: h?.loaded_model ?? models[0]?.name ?? null };
    }
    const wrapped = d as { models?: EngineModel[]; default_model?: string } | undefined;
    return { models: wrapped?.models ?? [], default_model: wrapped?.default_model ?? null };
  } catch {
    return null;
  }
}

export type GenerateParams = {
  prompt: string;
  lyrics: string;
  audio_duration?: number | null;
  vocal_language?: string;
  model?: string | null;
  batch_size?: number;
  inference_steps?: number;
  seed?: number;
  audio_format?: "mp3" | "wav" | "flac" | "opus" | "aac";
  bpm?: number | null;
  key_scale?: string;
  time_signature?: string;
  /** Description-only generation handled by ACE-Step's own LM. */
  sample_query?: string;
  thinking?: boolean;
  use_format?: boolean;
};

export async function releaseTask(params: GenerateParams) {
  return call<{ task_id: string; status: string; queue_position?: number }>("/release_task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_format: "mp3", batch_size: 2, inference_steps: 8, ...params }),
  });
}

/** One entry per generated audio inside `result` (a JSON string). */
export type TaskResultItem = {
  file: string; // "/v1/audio?path=..." or "" while pending
  status: number; // 0 running, 1 succeeded, 2 failed
  prompt?: string;
  lyrics?: string;
  metas?: { bpm?: number | string; duration?: number | string; keyscale?: string; timesignature?: string; genres?: string };
  progress?: number;
  stage?: string;
  error?: string | null;
};

export type TaskStatus = {
  task_id: string;
  status: number;
  progress_text?: string;
  result: string;
  items: TaskResultItem[];
};

export async function queryResults(taskIds: string[]): Promise<TaskStatus[]> {
  if (taskIds.length === 0) return [];
  const raw = await call<Array<Omit<TaskStatus, "items">>>("/query_result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id_list: taskIds }),
  });
  return raw.map((r) => {
    let items: TaskResultItem[] = [];
    try {
      const parsed = JSON.parse(r.result);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      /* result may be a plain error string */
    }
    return { ...r, items };
  });
}

export async function downloadAudio(fileUrl: string): Promise<Buffer> {
  const res = await fetch(`${BASE}${fileUrl}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo descargar el audio (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Ask ACE-Step's LM to polish caption/lyrics. Requires ACESTEP_INIT_LLM=true. */
export async function formatInput(prompt: string, lyrics: string, language?: string) {
  return call<{ caption?: string; lyrics?: string; bpm?: number; duration?: number; keyscale?: string; timesignature?: string; language?: string }>(
    "/format_input",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, lyrics, param_obj: language ? { language } : {} }),
    },
  );
}

export type EditParams = {
  task_type: "cover" | "repaint";
  prompt: string;
  lyrics: string;
  vocal_language?: string;
  model?: string | null;
  audio_cover_strength?: number;
  repainting_start?: number;
  repainting_end?: number;
  batch_size?: number;
  seed?: number;
};

/** Submits a cover/repaint task uploading the source audio as multipart (`src_audio`). */
export async function releaseEditTask(params: EditParams, srcAudio: { buffer: Buffer; filename: string }) {
  const form = new FormData();
  const fields: Record<string, string> = {
    task_type: params.task_type,
    prompt: params.prompt,
    lyrics: params.lyrics,
    vocal_language: params.vocal_language ?? "es",
    audio_format: "mp3",
    batch_size: String(params.batch_size ?? 1),
    inference_steps: "8",
    thinking: "false",
    use_format: "false",
  };
  if (params.model) fields.model = params.model;
  if (params.task_type === "cover") fields.audio_cover_strength = String(params.audio_cover_strength ?? 0.8);
  if (params.task_type === "repaint") {
    fields.repainting_start = String(params.repainting_start ?? 0);
    fields.repainting_end = String(params.repainting_end ?? -1);
    fields.chunk_mask_mode = "explicit";
  }
  if (params.seed !== undefined) fields.seed = String(params.seed);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("src_audio", new Blob([new Uint8Array(srcAudio.buffer)], { type: "audio/mpeg" }), srcAudio.filename);
  const res = await fetch(`${BASE}/release_task`, { method: "POST", body: form, cache: "no-store" });
  const body = (await res.json().catch(() => null)) as Envelope<{ task_id: string; status: string; queue_position?: number }> | null;
  if (!res.ok || !body || (body.code && body.code !== 200)) throw new Error(body?.error ?? `ACE-Step /release_task respondió ${res.status}`);
  return body.data;
}
