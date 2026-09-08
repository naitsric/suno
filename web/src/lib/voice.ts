/** Client for the voice conversion service (engine/voice/server.py, port 8002). */
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.VOICE_URL ?? "http://127.0.0.1:8002").replace(/\/$/, "");

export type VoiceHealth = { status: string; device: string; models_loaded: boolean; queued: number };
export type VoiceJob = { job_id: string; status: "queued" | "running" | "done" | "failed"; stage: string; error: string | null; octave_shift?: number };
export type VoiceKind = "speech" | "singing";
export type ReferenceProfile = {
  kind?: VoiceKind;
  median_hz: number;
  p10_hz: number;
  p90_hz: number;
  voiced_ratio: number;
  median_note: string;
  register: string;
  sing_low_hz: number;
  sing_high_hz: number;
  sing_low_note: string;
  sing_high_note: string;
};

export async function health(): Promise<VoiceHealth | null> {
  try {
    const res = await fetch(`${BASE}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as VoiceHealth) : null;
  } catch {
    return null;
  }
}

/** Pitch profile of a reference recording (median F0, register, comfortable singing range). ~2 s. */
export async function analyzeReference(referencePath: string, kind: VoiceKind = "speech"): Promise<ReferenceProfile> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(referencePath)]), path.basename(referencePath));
  form.append("kind", kind);
  const res = await fetch(`${BASE}/analyze`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Análisis de voz falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as ReferenceProfile;
}

export type TimedWord = { text: string; start: number; end: number };
export type TimedLine = { text: string; start: number; end: number; matched: number; words: TimedWord[] };

/** Times every lyric line/word against the sung vocals (Demucs + faster-whisper + alignment). ~1 min per song. */
export async function alignLyrics(songPath: string, lyrics: string, language: string, duration: number | null): Promise<{ lines: TimedLine[]; confidence: number }> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(songPath)]), path.basename(songPath));
  form.append("lyrics", lyrics);
  form.append("language", language);
  form.append("model", "medium");
  form.append("duration", String(duration ?? 0));
  const res = await fetch(`${BASE}/align-lyrics`, { method: "POST", body: form, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`Alineación de la letra falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { lines: TimedLine[]; confidence: number };
}

/** The best 30 s of a song's vocals as a sung reference (WAV mono 44.1 kHz) plus where it was taken from. */
export async function extractReference(songPath: string, seconds = 30): Promise<{ wav: Buffer; info: { start_sec: number; end_sec: number; sung_density: number } | null }> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(songPath)]), path.basename(songPath));
  form.append("seconds", String(seconds));
  const res = await fetch(`${BASE}/extract-reference`, { method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Extraer la voz falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  let info = null;
  try {
    info = JSON.parse(res.headers.get("x-extract-info") ?? "null");
  } catch {
    /* optional */
  }
  return { wav: Buffer.from(await res.arrayBuffer()), info };
}

/** Studio cleanup of a spoken reference (Demucs vocal stem + speech chain). Returns WAV mono 44.1 kHz and stats. */
export async function cleanReference(referencePath: string): Promise<{ wav: Buffer; info: { demucs: boolean; reverb_removed_db: number | null; strong_denoise: boolean; presence_boost: boolean; hi_mid_before_db: number; hi_mid_after_db: number; noise_floor_before_db: number; noise_floor_after_db: number } | null }> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(referencePath)]), path.basename(referencePath));
  const res = await fetch(`${BASE}/clean-reference`, { method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Retoque de voz falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  let info = null;
  try {
    info = JSON.parse(res.headers.get("x-clean-info") ?? "null");
  } catch {
    /* optional */
  }
  return { wav: Buffer.from(await res.arrayBuffer()), info };
}

export type SculptParams = { formant: number; pitch: number; brightness: number };
export type SculptInfo = { f0_median_before_hz: number; f0_median_after_hz: number; centroid_before_hz: number; centroid_after_hz: number } | null;

/** Reshapes a reference's timbre (formants %, pitch semitones, air dB) with Praat. Returns WAV mono 44.1 kHz and measurements. */
export async function sculptReference(referencePath: string, p: SculptParams): Promise<{ wav: Buffer; info: SculptInfo }> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(referencePath)]), path.basename(referencePath));
  form.append("formant_pct", String(p.formant));
  form.append("pitch_st", String(p.pitch));
  form.append("brightness_db", String(p.brightness));
  const res = await fetch(`${BASE}/sculpt-reference`, { method: "POST", body: form, signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`Esculpir la voz falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  let info: SculptInfo = null;
  try {
    info = JSON.parse(res.headers.get("x-sculpt-info") ?? "null");
  } catch {
    /* optional */
  }
  return { wav: Buffer.from(await res.arrayBuffer()), info };
}

export async function submitConversion(songPath: string, referencePath: string, opts: { pitchShift?: number; diffusionSteps?: number; autoOctave?: boolean; autotune?: boolean; autotuneStrength?: number; keyScale?: string | null; refKind?: VoiceKind } = {}) {
  const form = new FormData();
  form.append("song", new Blob([fs.readFileSync(songPath)]), path.basename(songPath));
  form.append("reference", new Blob([fs.readFileSync(referencePath)]), path.basename(referencePath));
  form.append("pitch_shift", String(opts.pitchShift ?? 0));
  form.append("diffusion_steps", String(opts.diffusionSteps ?? 30));
  form.append("auto_octave", String(opts.autoOctave ?? true));
  form.append("autotune", String(opts.autotune ?? false));
  form.append("autotune_strength", String(opts.autotuneStrength ?? 0.8));
  form.append("key_scale", opts.keyScale ?? "");
  form.append("ref_kind", opts.refKind ?? "speech");
  const res = await fetch(`${BASE}/convert`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Servicio de voz respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { job_id: string; status: string; queue_position: number };
}

/** Returns null when the service no longer knows the job (jobs live in memory; a restart forgets them). */
export async function jobStatus(jobId: string): Promise<VoiceJob | null> {
  const res = await fetch(`${BASE}/jobs/${jobId}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Servicio de voz respondió ${res.status}`);
  return (await res.json()) as VoiceJob;
}

export async function downloadJobAudio(jobId: string): Promise<Buffer> {
  const res = await fetch(`${BASE}/jobs/${jobId}/audio`, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo descargar la voz convertida (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Runs the AI restoration model (Apollo) on a full mix; returns the enhanced audio (WAV 44.1k). */
export async function enhanceAudio(songPath: string): Promise<Buffer> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(songPath)]), path.basename(songPath));
  const res = await fetch(`${BASE}/enhance`, { method: "POST", body: form, signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok) throw new Error(`Realce IA falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export type ReferenceProgress = { stage: string | null };

/**
 * Measures a reference song (YouTube URL or local file) with the voice service: tempo, key, energy,
 * structure, stem balance, vocals + language and CLAP genre/mood/instrument tags. 1–3 min per song;
 * `token` lets the caller poll `referenceProgress` meanwhile.
 */
export async function analyzeMusicReference(input: { url?: string; filePath?: string; token?: string }): Promise<Record<string, unknown>> {
  const form = new FormData();
  if (input.filePath) form.append("audio", new Blob([fs.readFileSync(input.filePath)]), path.basename(input.filePath));
  else form.append("url", input.url ?? "");
  if (input.token) form.append("token", input.token);
  const res = await fetch(`${BASE}/reference-analysis`, { method: "POST", body: form, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    let detail = text;
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
    } catch {
      /* plain text */
    }
    throw new Error(res.status === 422 ? detail : `Análisis de referencia falló (${res.status}): ${detail}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function referenceProgress(token: string): Promise<ReferenceProgress> {
  try {
    const res = await fetch(`${BASE}/reference-analysis/${encodeURIComponent(token)}`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as ReferenceProgress) : { stage: null };
  } catch {
    return { stage: null };
  }
}
