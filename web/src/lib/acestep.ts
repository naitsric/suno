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
    // FastAPI's HTTPException puts the reason in `detail`, outside the envelope.
    const detail = (body as unknown as { detail?: unknown }).detail;
    throw new Error(body.error ?? (typeof detail === "string" ? detail : null) ?? `ACE-Step ${path} respondió ${res.status}`);
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

// ---------------------------------------------------------------------------------------------------
// LoRA per artist: dataset → tensors → training → export → load (all local, engine/ACE-Step-1.5 docs/en/API.md)
// ---------------------------------------------------------------------------------------------------
function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export type DatasetSample = { idx?: number; filename?: string; audio_path?: string; caption?: string; genre?: string; lyrics?: string; bpm?: number | null; keyscale?: string; language?: string; is_instrumental?: boolean };

/** Scans a folder of audio (+ `<name>.lyrics.txt` / `<name>.caption.txt` sidecars) into the engine's in-memory dataset. */
export async function datasetScan(audioDir: string, datasetName: string, customTag: string) {
  return call<{ num_samples: number; samples: DatasetSample[] }>("/v1/dataset/scan", json({ audio_dir: audioDir, dataset_name: datasetName, custom_tag: customTag, tag_position: "prepend", all_instrumental: false }));
}

export async function datasetUpdateSample(idx: number, sample: { caption: string; genre: string; lyrics: string; bpm: number | null; keyscale: string; language: string }) {
  return call<unknown>(`/v1/dataset/sample/${idx}`, { ...json({ sample_idx: idx, ...sample, prompt_override: null, timesignature: "", is_instrumental: false }), method: "PUT" });
}

export async function datasetSave(savePath: string, datasetName: string) {
  return call<{ message: string; save_path: string }>("/v1/dataset/save", json({ save_path: savePath, dataset_name: datasetName }));
}

export async function datasetPreprocessStart(outputDir: string) {
  return call<{ task_id: string }>("/v1/dataset/preprocess_async", json({ output_dir: outputDir, skip_existing: true }));
}

export type PreprocessStatus = { task_id: string | null; status: "idle" | "running" | "completed" | "failed" | string; progress: string; current?: number; total?: number; error?: string | null; result?: unknown };

export async function datasetPreprocessStatus(taskId: string) {
  return call<PreprocessStatus>(`/v1/dataset/preprocess_status/${taskId}`);
}

export type TrainingParams = { tensor_dir: string; lora_output_dir: string; train_epochs: number; lora_rank: number; lora_alpha: number; learning_rate: number; save_every_n_epochs: number; gradient_checkpointing: boolean };

export async function trainingStart(params: TrainingParams) {
  return call<unknown>("/v1/training/start", json({ lora_dropout: 0.1, train_batch_size: 1, gradient_accumulation: 4, training_shift: 3.0, training_seed: 42, use_fp8: false, ...params }));
}

export type TrainingStatus = { is_training: boolean; should_stop: boolean; current_step: number; current_loss: number | null; status: string; current_epoch: number; steps_per_second: number; estimated_time_remaining: number; error: string | null; config?: Record<string, unknown> };

export async function trainingStatus() {
  return call<TrainingStatus>("/v1/training/status");
}

export async function trainingStop() {
  return call<unknown>("/v1/training/stop", json({}));
}

export async function trainingExport(loraOutputDir: string, exportPath: string) {
  return call<{ message: string; export_path: string }>("/v1/training/export", json({ lora_output_dir: loraOutputDir, export_path: exportPath }));
}

/** Reloads the engine's models (used to bring its LM back after a training run unloaded it). Slow (~1–2 min). */
export async function reinitialize() {
  return call<unknown>("/v1/reinitialize", json({}));
}

/** Adds a PEFT adapter under `adapterName` (unique per artist) and makes it the active one. */
export async function loadLora(loraPath: string, adapterName?: string) {
  return call<{ message: string }>("/v1/lora/load", json({ lora_path: loraPath, adapter_name: adapterName ?? null }));
}

export type LoraStatus = { lora_loaded: boolean; use_lora: boolean; lora_scale: number; active_adapter: string | null; adapters: string[]; scales: Record<string, number> };

export async function loraStatus() {
  return call<LoraStatus>("/v1/lora/status");
}

/** Enables/disables the loaded adapters for inference (PEFT enable/disable_adapter_layers). */
export async function toggleLora(useLora: boolean) {
  return call<unknown>("/v1/lora/toggle", json({ use_lora: useLora }));
}

export async function unloadLora() {
  return call<unknown>("/v1/lora/unload", json({}));
}

export async function setLoraScale(scale: number) {
  return call<unknown>("/v1/lora/scale", json({ scale }));
}
