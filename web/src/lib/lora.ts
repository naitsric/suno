/**
 * Artist LoRA for ACE-Step: the engine learns the artist's voice from their own songs, so new generations
 * come out singing with that voice straight from the model (no Demucs, no Seed-VC, no vocoder).
 *
 * Pipeline (all inside the engine, `engine/ACE-Step-1.5`): the artist's finished songs (`<id>.raw.mp3`,
 * with their lyrics and style as sidecars) → `/v1/dataset/scan` (activation tag = the artist's slug) →
 * per-sample metadata (bpm, key, language) → save → `/v1/dataset/preprocess_async` (tensors) →
 * `/v1/training/start` (LoRA on the decoder; the engine unloads its LM and offloads the encoders, so it
 * cannot generate meanwhile) → `/v1/training/export` → `artists.lora_path`. Then `createSong` with
 * `useLora` loads it (`/v1/lora/load`) and prepends the activation tag to the style.
 *
 * Files live under `engine/ACE-Step-1.5/.cache/lora/<artistId>/` (dataset, tensors, output, export; the engine
 * refuses paths outside its own directory). Only one training at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { artists, songs, voices, type Artist } from "@/db/schema";
import * as engine from "./acestep";

const AUDIO_DIR = process.env.AUDIO_DIR ?? "./data/audio";
// The engine only accepts paths under its own working directory (`acestep/training/path_safety.py`, safe root =
// cwd = engine/ACE-Step-1.5), so the LoRA files live in its ignored `.cache` instead of web/data.
const LORA_DIR = process.env.LORA_DIR ?? path.resolve(process.cwd(), "../engine/ACE-Step-1.5/.cache/lora");

export type LoraOptions = { epochs?: number; rank?: number; minSongs?: number };

let running: string | null = null; // artist id whose LoRA is being built

function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "artist";
}

function setLora(id: string, patch: Partial<Pick<Artist, "loraStatus" | "loraPath" | "loraProgress" | "loraError" | "loraTag" | "loraAdapter">>) {
  db.update(artists).set(patch).where(eq(artists.id, id)).run();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const MIN_SIMILARITY = 0.8;

/**
 * The artist's usable training material: finished, sung songs whose raw model output still exists AND whose
 * singer is the artist's voice. Every generation has a random singer, so "sung by the artist" means: the song
 * the artist's default voice was extracted from, or a song scored ≥ MIN_SIMILARITY against that voice
 * (`songs.voice_similarity`, see the voice-match flow). Converted mixes are never used: the LoRA would learn
 * Seed-VC's texture. Without a default voice every sung song counts.
 */
export function trainingSongs(artistId: string) {
  const artist = db.select().from(artists).where(eq(artists.id, artistId)).get();
  const voice = artist?.defaultVoiceId ? db.select().from(voices).where(eq(voices.id, artist.defaultVoiceId)).get() : undefined;
  return db
    .select()
    .from(songs)
    .where(eq(songs.artistId, artistId))
    .all()
    .filter((s) => s.status === "done" && !s.instrumental && s.lyrics && s.lyrics.trim() && !/^\[instrumental\]$/i.test(s.lyrics.trim()))
    .filter((s) => fs.existsSync(path.join(AUDIO_DIR, `${s.id}.raw.mp3`)))
    .filter((s) => !voice || s.id === voice.sourceSongId || (s.voiceMatchId === voice.id && (s.voiceSimilarity ?? 0) >= MIN_SIMILARITY));
}

/**
 * Starts the LoRA pipeline for an artist (returns at once; progress in `artists.lora_progress`).
 * Refuses while another LoRA is being built or the engine has generations in flight (training unloads the LM).
 */
export function startArtistLora(artistId: string, opts: LoraOptions = {}): Artist {
  const artist = db.select().from(artists).where(eq(artists.id, artistId)).get();
  if (!artist) throw new Error("No existe");
  if (running) throw new Error(running === artistId ? "Ya se está entrenando la voz de este artista" : "Ya hay un entrenamiento en marcha; espera a que termine");
  const busy = db.select({ id: songs.id }).from(songs).all().length && db.select().from(songs).all().some((s) => s.status === "queued" || s.status === "generating");
  if (busy) throw new Error("Hay canciones generándose: el entrenamiento apaga el motor mientras dura. Espera a que terminen.");
  const material = trainingSongs(artistId);
  const minSongs = opts.minSongs ?? 3;
  if (material.length < minSongs) throw new Error(`Hacen falta al menos ${minSongs} canciones terminadas con letra (hay ${material.length})`);
  running = artistId;
  const tag = `${slug(artist.name)}_voice`;
  setLora(artistId, { loraStatus: "preparing", loraProgress: `Preparando ${material.length} canciones`, loraError: null, loraTag: tag });
  void runPipeline(artist, material, tag, opts).finally(() => {
    running = null;
  });
  return db.select().from(artists).where(eq(artists.id, artistId)).get()!;
}

async function runPipeline(artist: Artist, material: ReturnType<typeof trainingSongs>, tag: string, opts: LoraOptions): Promise<void> {
  const root = path.resolve(LORA_DIR, artist.id);
  const dataset = path.join(root, "dataset");
  const tensors = path.join(root, "tensors");
  const output = path.join(root, "output");
  const exportDir = path.join(root, "export");
  const progress = (text: string) => setLora(artist.id, { loraProgress: text.slice(0, 300) });
  try {
    fs.rmSync(dataset, { recursive: true, force: true });
    fs.mkdirSync(dataset, { recursive: true });
    for (const s of material) {
      fs.copyFileSync(path.join(AUDIO_DIR, `${s.id}.raw.mp3`), path.join(dataset, `${s.id}.mp3`));
      fs.writeFileSync(path.join(dataset, `${s.id}.lyrics.txt`), s.lyrics ?? "");
      fs.writeFileSync(path.join(dataset, `${s.id}.caption.txt`), s.style ?? "");
    }
    progress("Leyendo el dataset en el motor");
    const scanned = await engine.datasetScan(dataset, tag, tag);
    // Metadata the engine would otherwise have to guess: tempo, key and language are stored per song.
    for (let i = 0; i < scanned.samples.length; i++) {
      const sample = scanned.samples[i];
      const file = path.basename(String(sample.audio_path ?? sample.filename ?? ""));
      const song = material.find((s) => file.startsWith(s.id));
      if (!song) continue;
      await engine.datasetUpdateSample(i, { caption: song.style, genre: song.style, lyrics: song.lyrics, bpm: song.bpm ?? null, keyscale: song.keyScale ?? "", language: song.vocalLanguage });
    }
    await engine.datasetSave(path.join(dataset, `${tag}.json`), tag);
    progress(`Codificando ${scanned.num_samples} canciones (tensores)`);
    const { task_id } = await engine.datasetPreprocessStart(tensors);
    for (;;) {
      await sleep(5000);
      const st = await engine.datasetPreprocessStatus(task_id);
      if (st.status === "completed") break;
      if (st.status === "failed") throw new Error(st.error ?? st.progress ?? "El preprocesado falló");
      progress(`Codificando: ${st.progress || `${st.current ?? 0}/${st.total ?? scanned.num_samples}`}`);
    }
    const epochs = Math.max(1, Math.min(opts.epochs ?? 10, 200));
    const rank = Math.max(4, Math.min(opts.rank ?? 64, 256));
    setLora(artist.id, { loraStatus: "training", loraProgress: `Entrenando (${epochs} épocas, rango ${rank})` });
    fs.rmSync(output, { recursive: true, force: true });
    await engine.trainingStart({ tensor_dir: tensors, lora_output_dir: output, train_epochs: epochs, lora_rank: rank, lora_alpha: rank * 2, learning_rate: 1e-4, save_every_n_epochs: Math.max(1, Math.min(5, epochs)), gradient_checkpointing: true });
    let lastError: string | null = null;
    for (;;) {
      await sleep(10000);
      const st = await engine.trainingStatus();
      lastError = st.error ?? null;
      const eta = st.estimated_time_remaining ? ` · ~${Math.round(st.estimated_time_remaining / 60)} min` : "";
      const loss = st.current_loss != null ? ` · loss ${st.current_loss.toFixed(3)}` : "";
      progress(`Entrenando: época ${st.current_epoch}/${epochs}, paso ${st.current_step}${loss}${eta} · ${st.status}`);
      if (!st.is_training) break;
    }
    if (lastError) throw new Error(lastError);
    progress("Exportando el LoRA");
    const exported = await engine.trainingExport(output, exportDir);
    // The export copies the trainer's `final/` folder, whose PEFT adapter lives in `adapter/` (adapter_config.json):
    // `/v1/lora/load` wants that inner directory, not the export root.
    const adapterDir = fs.existsSync(path.join(exported.export_path, "adapter", "adapter_config.json")) ? path.join(exported.export_path, "adapter") : exported.export_path;
    // A fresh adapter name per training: the engine keeps loaded adapters in memory and cannot replace one in
    // place, so re-adding under the old name would keep serving the previous weights.
    setLora(artist.id, { loraStatus: "done", loraPath: adapterDir, loraAdapter: `${tag}_${Date.now().toString(36)}`, loraProgress: `Listo: ${material.length} canciones, ${epochs} épocas` });
    // Training leaves the engine dirty: its LM unloaded (simple mode needs it) and the decoder wrapped by the
    // trainer's own PEFT adapter with no base backup, so `/v1/lora/unload` fails with "Base decoder backup not
    // found". `/v1/reinitialize` reloads everything clean (~1–2 min); the engine's docs ask for it before training too.
    try {
      progress("Recargando el motor (LM y decoder limpios)");
      await engine.reinitialize();
    } catch (err) {
      setLora(artist.id, { loraError: `El motor no se recargó tras entrenar (haz POST :8001/v1/reinitialize): ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) });
    }
    setLora(artist.id, { loraProgress: `Listo: ${material.length} canciones, ${epochs} épocas` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setLora(artist.id, { loraStatus: "failed", loraError: msg.slice(0, 500), loraProgress: "" });
  }
}

/** Stops a running training (the checkpoint so far is still exportable by starting again later). */
export async function stopArtistLora(artistId: string): Promise<Artist> {
  if (running !== artistId) throw new Error("No hay entrenamiento en marcha para este artista");
  await engine.trainingStop();
  return db.select().from(artists).where(eq(artists.id, artistId)).get()!;
}

/** Live view: DB state plus the engine's own training counters while it trains. */
export async function artistLoraStatus(artistId: string) {
  const artist = db.select().from(artists).where(eq(artists.id, artistId)).get();
  if (!artist) throw new Error("No existe");
  let training: engine.TrainingStatus | null = null;
  if (artist.loraStatus === "training") {
    try {
      training = await engine.trainingStatus();
    } catch {
      /* engine down: the DB text is all we have */
    }
  }
  return { status: artist.loraStatus, path: artist.loraPath, progress: artist.loraProgress, error: artist.loraError, tag: artist.loraTag, songs: trainingSongs(artistId).length, running: running === artistId, training };
}

/**
 * Makes the engine generate with (or without) an artist's LoRA. Adapter state is global in the engine, so this
 * runs right before every `release_task`, driven by `/v1/lora/status` (never by memory of this process):
 * the artist's adapter is added under its own name (`loraTag`) the first time and becomes the active one;
 * songs without LoRA just disable the adapter layers (`/v1/lora/toggle`), the base model answers.
 * Returns the activation tag to prepend to the style (empty when no LoRA is used).
 */
export async function applyLoraForGeneration(artist: Artist | undefined, useLora: boolean): Promise<string> {
  const status = await engine.loraStatus().catch(() => null);
  if (useLora && artist?.loraStatus === "done" && artist.loraPath && artist.loraTag && fs.existsSync(artist.loraPath)) {
    const name = artist.loraAdapter ?? artist.loraTag;
    if (!status?.adapters.includes(name)) {
      await engine.loadLora(artist.loraPath, name); // add_lora: becomes the active adapter
    } else if (status.active_adapter !== name) {
      // Another artist's adapter is active and the engine has no HTTP route to switch: drop everything and reload.
      // (unload needs the base backup the first `load` made; after a training run only `make engine` cleans it.)
      await engine.unloadLora();
      await engine.loadLora(artist.loraPath, name);
    }
    await engine.toggleLora(true);
    return artist.loraTag;
  }
  if (status?.use_lora) await engine.toggleLora(false);
  return "";
}
