/** Client for the stills video service (engine/video/stills/server.py, port 8003). */
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.VIDEO_URL ?? "http://127.0.0.1:8003").replace(/\/$/, "");

export type VideoHealth = { status: string; device: string; free_gb: number; min_free_gb: number; busy: boolean; queued: number };
export type VideoJob = { job_id: string; status: "queued" | "waiting" | "rendering" | "assembling" | "done" | "failed"; stage: string; done: number; total: number; error: string | null };
export type StoryboardScene = { section: string; prompt: string; duration: number };
export type Storyboard = { /** visual language of the whole video, from the artist's genre/personality */ style: string; character: string; scenes: StoryboardScene[]; total: number; /** timed lyrics burned as karaoke (optional) */ lyrics?: { text: string; start: number; end: number; words: { text: string; start: number; end: number }[] }[] };

export async function health(): Promise<VideoHealth | null> {
  try {
    const res = await fetch(`${BASE}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as VideoHealth) : null;
  } catch {
    return null;
  }
}

export async function submitVideo(audioPath: string, storyboard: Storyboard, opts: { referencePath?: string | null; steps?: number; seed?: number; /** pre-rendered scenes (e.g. OpenAI), one per storyboard scene, in order */ imagePaths?: string[] } = {}) {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
  form.append("storyboard", JSON.stringify(storyboard));
  if (opts.referencePath && fs.existsSync(opts.referencePath)) form.append("reference", new Blob([fs.readFileSync(opts.referencePath)]), path.basename(opts.referencePath));
  for (const p of opts.imagePaths ?? []) form.append("images", new Blob([fs.readFileSync(p)], { type: "image/png" }), path.basename(p));
  form.append("steps", String(opts.steps ?? 25));
  form.append("seed", String(opts.seed ?? 7));
  const res = await fetch(`${BASE}/videos`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Servicio de video respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { job_id: string; status: string; queue_position: number };
}

/** null when the service no longer knows the job (jobs live in memory; a restart forgets them). */
export async function videoStatus(jobId: string): Promise<VideoJob | null> {
  const res = await fetch(`${BASE}/videos/${jobId}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Servicio de video respondió ${res.status}`);
  return (await res.json()) as VideoJob;
}

export async function downloadVideo(jobId: string): Promise<Buffer> {
  const res = await fetch(`${BASE}/videos/${jobId}/video`, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo descargar el video (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
