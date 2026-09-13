import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { songs, type Song } from "@/db/schema";
import * as engine from "./acestep";
import { draftSong, ollamaAvailable, planEdit, type EditPlan } from "./ollama";
import * as voice from "./voice";
import { parseConversionOptions, type ConversionOptions } from "./voice-options";
import * as video from "./video";
import { buildStoryboard } from "./storyboard";
import { masterAudio, type MasterPreset } from "./master";
import { analyzeVoice, getVoice, voiceKind, voicePath, voiceProfile, voiceRegister } from "./voices";
import { applyGender, applyRegister, genderInStyle, voiceBrief, voicePromptTags, type Register } from "./voice-register";
import { artistImagePath, getAlbum, getArtist } from "./artists";
import { applyLoraForGeneration } from "./lora";
import { generateImage, generateImageWithReference, openaiConfigured } from "./openai-images";

const PORTRAITS_DIR = process.env.PORTRAITS_DIR ?? "./data/portraits";

const AUDIO_DIR = process.env.AUDIO_DIR ?? "./data/audio";
const VARIANTS = 2;

export type CreateSongInput = {
  mode: "simple" | "custom";
  title?: string;
  description?: string;
  style?: string;
  lyrics?: string;
  instrumental: boolean;
  duration?: number | null;
  vocalLanguage: string;
  model?: string | null;
  voiceId?: string | null;
  autotune?: boolean;
  /** Conversion quality knobs (see lib/voice-options.ts); omitted = service defaults. */
  voiceOptions?: ConversionOptions | null;
  /** Number of generations (1–6; default 2). More candidates = more chances one sings like the artist. */
  variants?: number;
  /** Score each generation's singer against this voice (no conversion): the closest one is the keeper. */
  voiceMatchId?: string | null;
  /** Generate with the artist's trained LoRA (needs `artists.lora_status = done`): the model sings with that voice. */
  useLora?: boolean;
  master?: MasterPreset;
  artistId?: string | null;
  albumId?: string | null;
  /** Fixed tempo/key (e.g. measured on a YouTube reference); otherwise the engine's LM picks them. */
  bpm?: number | null;
  keyScale?: string | null;
};

function now() {
  return Date.now();
}

function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 45)}…` : clean || "Sin título";
}

/** Builds the engine request, submits it and stores one row per expected variant. */
export async function createSong(input: CreateSongInput): Promise<Song[]> {
  let title = input.title?.trim() ?? "";
  let style = input.style?.trim() ?? "";
  let lyrics = input.lyrics?.trim() ?? "";
  const description = input.description?.trim() ?? "";
  let sampleQuery: string | undefined;

  // Singing with a voice profile: write the music in that voice's register so the melody lands where
  // the reference recording lives (the conversion breaks when the melody sits far above it).
  let register: Register | null = null;
  let voiceTags = "";
  let brief: string | null = null;
  const referenceVoiceId = input.voiceId ?? input.voiceMatchId;
  if (referenceVoiceId && !input.instrumental) {
    let v = getVoice(referenceVoiceId);
    if (!v) throw new Error("La voz seleccionada ya no existe.");
    if (v.profile === null) v = await analyzeVoice(v);
    register = voiceRegister(v);
    if (register) {
      const profile = voiceProfile(v);
      voiceTags = voicePromptTags(register, profile);
      brief = voiceBrief(register, profile);
    }
  }
  // No voice profile: at least keep the vocal gender the artist declares in their style.
  const artistGender = !register && input.artistId && !input.instrumental ? genderInStyle(getArtist(input.artistId)?.style ?? "") : null;
  if (artistGender && !brief) brief = artistGender === "female" ? "voz femenina (usa 'female vocals' en el estilo, nunca 'male vocals')" : "voz masculina (usa 'male vocals' en el estilo, nunca 'female vocals')";

  if (input.mode === "simple") {
    if (!description) throw new Error("Describe la canción que quieres.");
    if (await ollamaAvailable()) {
      const draft = await draftSong({ description, language: input.vocalLanguage, instrumental: input.instrumental, voice: brief });
      title ||= draft.title;
      style ||= draft.style;
      lyrics = draft.lyrics;
    } else {
      // Fall back to ACE-Step's own LM planner (needs ACESTEP_INIT_LLM=true).
      sampleQuery = input.instrumental ? `${description} (instrumental, no vocals)` : register ? `${description} (${voiceTags})` : description;
      title ||= titleFrom(description);
    }
  } else {
    if (!style) throw new Error("Indica el estilo de la canción.");
    if (input.instrumental) lyrics = "[Instrumental]";
    if (!lyrics) throw new Error("Escribe la letra o marca instrumental.");
    title ||= titleFrom(lyrics.split("\n").find((l) => l && !l.startsWith("[")) ?? style);
  }

  if (register && !sampleQuery) style = applyRegister(style, register, voiceTags);
  else if (artistGender && !sampleQuery) style = applyGender(style, artistGender);
  else if (artistGender && sampleQuery) sampleQuery += ` (${artistGender} vocals)`;
  if (input.albumId) {
    const album = getAlbum(input.albumId);
    if (!album || album.artistId !== input.artistId) throw new Error("El álbum no pertenece a ese artista.");
  }
  if (input.instrumental) {
    lyrics = "[Instrumental]";
    if (style && !/instrumental/i.test(style)) style = `${style}, instrumental`;
  }

  const params: engine.GenerateParams = sampleQuery
    ? { prompt: "", lyrics: "", sample_query: sampleQuery, thinking: true, audio_duration: input.duration ?? null, vocal_language: input.vocalLanguage, model: input.model ?? null }
    : { prompt: style, lyrics, audio_duration: input.duration ?? null, vocal_language: input.vocalLanguage, model: input.model ?? null };
  const variants = Math.max(1, Math.min(input.variants ?? VARIANTS, 6));
  params.batch_size = variants;
  if (input.bpm) params.bpm = input.bpm;
  if (input.keyScale) params.key_scale = input.keyScale;

  // Artist LoRA: the engine holds one adapter globally, so it is (un)loaded right before every task.
  const loraTag = await applyLoraForGeneration(input.artistId ? getArtist(input.artistId) : undefined, !!input.useLora);
  if (loraTag) {
    if (params.sample_query) params.sample_query = `${loraTag}, ${params.sample_query}`;
    else params.prompt = `${loraTag}, ${params.prompt}`;
  }
  const task = await engine.releaseTask(params);
  const ts = now();
  const voiceMatchId = !input.instrumental && input.voiceMatchId && getVoice(input.voiceMatchId) ? input.voiceMatchId : null;
  const rows = Array.from({ length: variants }, (_, variant) => ({
    id: randomUUID(),
    taskId: task.task_id,
    variant,
    title,
    mode: input.mode,
    description,
    style,
    lyrics,
    instrumental: input.instrumental,
    duration: input.duration ?? null,
    vocalLanguage: input.vocalLanguage,
    model: input.model ?? null,
    voiceId: input.instrumental ? null : input.voiceId ?? null,
    autotune: !!input.autotune && !input.instrumental && !!input.voiceId,
    voiceOptions: input.voiceOptions && Object.keys(input.voiceOptions).length ? JSON.stringify(input.voiceOptions) : null,
    voiceMatchId,
    masterPreset: input.master ?? "off",
    artistId: input.artistId ?? null,
    albumId: input.albumId ?? null,
    status: "queued" as const,
    progress: task.queue_position ? `En cola (#${task.queue_position})` : "En cola",
    createdAt: ts,
    updatedAt: ts,
  }));
  db.insert(songs).values(rows).run();
  return db.select().from(songs).where(eq(songs.taskId, task.task_id)).orderBy(songs.variant).all();
}

export function listSongs(filter: { artistId?: string | null } = {}): Song[] {
  const q = db.select().from(songs);
  const where = filter.artistId === undefined ? undefined : filter.artistId === null ? isNull(songs.artistId) : eq(songs.artistId, filter.artistId);
  return (where ? q.where(where) : q).orderBy(desc(songs.createdAt), songs.variant).all();
}

export function updateSongMeta(id: string, patch: { title?: string }) {
  if (!getSong(id)) throw new Error("No existe");
  db.update(songs).set({ ...(patch.title !== undefined ? { title: patch.title.trim() || "Sin título" } : {}), updatedAt: now() }).where(eq(songs.id, id)).run();
  return getSong(id)!;
}

export function getSong(id: string): Song | undefined {
  return db.select().from(songs).where(eq(songs.id, id)).get();
}

export function deleteSong(id: string) {
  const song = getSong(id);
  if (!song) return false;
  for (const f of [song.audioFile, song.originalAudioFile, song.rawAudioFile, song.videoFile, `${song.id}.raw.mp3`, `${song.id}.voice.raw.mp3`]) {
    if (f) fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
  }
  db.delete(songs).where(eq(songs.id, id)).run();
  return true;
}

export function audioPathFor(song: Song, original = false) {
  const f = original ? song.originalAudioFile : song.audioFile;
  return f ? path.join(AUDIO_DIR, f) : null;
}

/** Polls the engine and the voice service for every unfinished song and persists results/audio. */
export async function syncPending(): Promise<void> {
  await syncGeneration();
  await syncVoiceConversion();
  await syncVideos();
  void syncVoiceMatch(); // scores in the background: the poll must not wait 30 s for Demucs
}

let voiceMatchInFlight = false;

/**
 * Scores finished songs that asked for a voice match: the model's own vocals (`<id>.raw.mp3`, never the
 * converted mix) against the chosen voice, one song at a time. The score lands on a later poll.
 */
async function syncVoiceMatch(): Promise<void> {
  if (voiceMatchInFlight) return;
  const row = db
    .select()
    .from(songs)
    .where(and(eq(songs.status, "done"), isNotNull(songs.voiceMatchId), isNull(songs.voiceSimilarity)))
    .limit(1)
    .get();
  if (!row?.voiceMatchId) return;
  voiceMatchInFlight = true;
  try {
    const v = getVoice(row.voiceMatchId);
    const raw = path.join(AUDIO_DIR, `${row.id}.raw.mp3`);
    const src = fs.existsSync(raw) ? raw : row.audioFile ? path.join(AUDIO_DIR, row.audioFile) : null;
    if (!v || !src) {
      db.update(songs).set({ voiceMatchId: null, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      return;
    }
    const similarity = await voice.voiceSimilarity(src, voicePath(v));
    db.update(songs).set({ voiceSimilarity: similarity, updatedAt: now() }).where(eq(songs.id, row.id)).run();
  } catch (err) {
    // Leave it unscored (retried on the next poll) but say why on the card.
    const msg = err instanceof Error ? err.message : String(err);
    db.update(songs).set({ error: `Parecido de voz: ${msg}`.slice(0, 300), updatedAt: now() }).where(eq(songs.id, row.id)).run();
  } finally {
    voiceMatchInFlight = false;
  }
}

/** Asks for (or re-does) the voice-similarity score of a finished song against `voiceId`. */
export function requestVoiceMatch(id: string, voiceId: string): Song {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done") throw new Error("La canción aún no está lista");
  if (!getVoice(voiceId)) throw new Error("Esa voz no existe");
  db.update(songs).set({ voiceMatchId: voiceId, voiceSimilarity: null, updatedAt: now() }).where(eq(songs.id, id)).run();
  void syncVoiceMatch();
  return getSong(id)!;
}

/**
 * Stills video for a finished song: Ollama writes the storyboard (one Pixar scene per section), the video
 * service renders the images with a consistent character and assembles a Ken Burns slideshow on the song.
 */
export type VideoProvider = "openai" | "local";

export async function startVideo(id: string, opts: { subtitles?: boolean; provider?: VideoProvider } = {}): Promise<Song> {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done" || !song.audioFile) throw new Error("La canción aún no está lista");
  if (song.videoStatus === "queued" || song.videoStatus === "rendering") throw new Error("Ya hay un video en marcha para esta canción");
  const provider: VideoProvider = opts.provider ?? (openaiConfigured() ? "openai" : "local");
  if (provider === "openai" && !openaiConfigured()) throw new Error("Falta OPENAI_API_KEY para generar las imágenes con OpenAI");
  if (!(await video.health())) throw new Error("El servicio de video está apagado: ejecuta make video");
  db.update(songs).set({ videoStatus: "queued", videoProgress: "Escribiendo el guion visual", videoError: null, videoJobId: null, updatedAt: now() }).where(eq(songs.id, id)).run();
  try {
    const storyboard = await buildStoryboard(song, song.artistId ? getArtist(song.artistId) ?? null : null);
    if (opts.subtitles !== false && !song.instrumental && song.lyrics.trim()) {
      // On-screen lyrics need the sung timing: the voice service aligns the lyrics to the vocals (~1 min).
      db.update(songs).set({ videoProgress: "Sincronizando la letra con la voz", updatedAt: now() }).where(eq(songs.id, id)).run();
      try {
        const aligned = await voice.alignLyrics(path.join(AUDIO_DIR, song.audioFile), song.lyrics, song.vocalLanguage, song.duration);
        if (aligned.confidence >= 0.25) storyboard.lyrics = aligned.lines;
        else console.warn(`[video] letra sin sincronizar para ${id}: confianza ${aligned.confidence}`);
      } catch (err) {
        console.warn(`[video] sin letra en pantalla para ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const artist = song.artistId ? getArtist(song.artistId) ?? null : null;
    db.update(songs).set({ storyboard: JSON.stringify(storyboard), updatedAt: now() }).where(eq(songs.id, id)).run();
    if (provider === "openai") {
      // Scenes come from gpt-image-1; the artist's portrait (or the first scene) is the identity reference.
      db.update(songs).set({ videoStatus: "rendering", videoProgress: `🎬 Imagen 1 de ${storyboard.scenes.length} (OpenAI)`, updatedAt: now() }).where(eq(songs.id, id)).run();
      const portrait = artist ? artistImagePath(artist) : null;
      void renderScenesWithOpenAI(id, storyboard, portrait && fs.existsSync(portrait) ? portrait : null).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(songs).set({ videoStatus: "failed", videoError: msg.slice(0, 500), videoProgress: "", updatedAt: now() }).where(eq(songs.id, id)).run();
      });
      return getSong(id)!;
    }
    const reference = song.artistId ? path.join(PORTRAITS_DIR, `${song.artistId}.png`) : null;
    const job = await video.submitVideo(path.join(AUDIO_DIR, song.audioFile), storyboard, { referencePath: reference });
    db.update(songs)
      .set({ videoJobId: job.job_id, videoProgress: `🎬 En cola (#${job.queue_position})`, updatedAt: now() })
      .where(eq(songs.id, id))
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(songs).set({ videoStatus: "failed", videoError: msg.slice(0, 500), videoProgress: "", updatedAt: now() }).where(eq(songs.id, id)).run();
    throw err;
  }
  return getSong(id)!;
}

const SCENES_DIR = process.env.VIDEO_SCENES_DIR ?? "./data/video-scenes";

/**
 * Generates every scene with OpenAI (sequentially, ~20 s each), keeping the protagonist consistent by passing
 * the artist portrait or the first scene as reference, then hands the images to the video service for the
 * assembly. Runs detached from the request; progress and failures land in the song row.
 */
async function renderScenesWithOpenAI(songId: string, storyboard: video.Storyboard, portraitPath: string | null): Promise<void> {
  const dir = path.join(SCENES_DIR, songId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const references: Buffer[] = portraitPath ? [fs.readFileSync(portraitPath)] : [];
  const paths: string[] = [];
  for (let i = 0; i < storyboard.scenes.length; i++) {
    const scene = storyboard.scenes[i];
    const prompt = `${storyboard.style}. ${storyboard.character}. ${scene.prompt}. Same protagonist as the reference image${references.length ? "" : " (none yet)"}, consistent look; no text, no letters, no logos, 3:2 landscape.`;
    db.update(songs).set({ videoProgress: `🎬 Imagen ${i + 1} de ${storyboard.scenes.length} (OpenAI)`, updatedAt: now() }).where(eq(songs.id, songId)).run();
    const png = references.length ? await generateImageWithReference(prompt, references, { size: "1536x1024", quality: "medium" }) : await generateImage(prompt, { size: "1536x1024", quality: "medium" });
    const file = path.join(dir, `scene_${String(i + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(file, png);
    paths.push(file);
    if (references.length === 0) references.push(png); // the first scene anchors the rest
  }
  const song = getSong(songId);
  if (!song?.audioFile) throw new Error("La canción desapareció durante el render");
  db.update(songs).set({ videoProgress: "🎬 Montando el video", updatedAt: now() }).where(eq(songs.id, songId)).run();
  const job = await video.submitVideo(path.join(AUDIO_DIR, song.audioFile), storyboard, { imagePaths: paths });
  db.update(songs).set({ videoJobId: job.job_id, videoStatus: "rendering", updatedAt: now() }).where(eq(songs.id, songId)).run();
}

async function syncVideos(): Promise<void> {
  const rows = db.select().from(songs).where(inArray(songs.videoStatus, ["queued", "rendering"])).all();
  if (rows.length === 0) return;
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  for (const row of rows) {
    if (!row.videoJobId) continue; // storyboard still being written by startVideo
    try {
      const job = await video.videoStatus(row.videoJobId);
      if (!job) {
        db.update(songs).set({ videoStatus: "failed", videoError: "El servicio de video se reinició y perdió el trabajo; vuelve a lanzarlo", videoProgress: "", updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else if (job.status === "failed") {
        db.update(songs).set({ videoStatus: "failed", videoError: job.error ?? "error desconocido", videoProgress: "", updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else if (job.status === "done") {
        const buf = await video.downloadVideo(row.videoJobId);
        const videoFile = `${row.id}.video.mp4`;
        fs.writeFileSync(path.join(AUDIO_DIR, videoFile), buf);
        db.update(songs).set({ videoStatus: "done", videoFile, videoProgress: "", videoError: null, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else {
        const pct = job.total ? ` · ${job.done}/${job.total}` : "";
        db.update(songs).set({ videoStatus: "rendering", videoProgress: `🎬 ${job.stage}${job.status === "rendering" ? pct : ""}`, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.update(songs).set({ videoProgress: `🎬 Servicio de video no disponible: ${msg}`.slice(0, 300), updatedAt: now() }).where(eq(songs.id, row.id)).run();
    }
  }
}

let generationSyncInFlight: Promise<void> | null = null;

/** Serialises overlapping polls (UI + curl) so two syncs never download the same task twice. */
function syncGeneration(): Promise<void> {
  if (!generationSyncInFlight) {
    generationSyncInFlight = syncGenerationOnce().finally(() => {
      generationSyncInFlight = null;
    });
  }
  return generationSyncInFlight;
}

async function syncGenerationOnce(): Promise<void> {
  const pending = db
    .select()
    .from(songs)
    .where(inArray(songs.status, ["queued", "generating"]))
    .all();
  if (pending.length === 0) return;

  const taskIds = [...new Set(pending.map((s) => s.taskId).filter((t): t is string => !!t))];
  let results: engine.TaskStatus[];
  try {
    results = await engine.queryResults(taskIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const s of pending) {
      db.update(songs).set({ progress: `Motor no disponible: ${msg}`, updatedAt: now() }).where(eq(songs.id, s.id)).run();
    }
    return;
  }

  for (const task of results) {
    const rows = pending.filter((s) => s.taskId === task.task_id).sort((a, b) => a.variant - b.variant);
    if (rows.length === 0) continue;

    if (task.status === 0) {
      const item = task.items[0];
      const stage = item?.stage ? `${item.stage}` : "";
      const pct = typeof item?.progress === "number" && item.progress > 0 ? ` ${Math.round(item.progress * 100)}%` : "";
      const progress = [stage + pct, task.progress_text].filter(Boolean).join(" · ").slice(0, 300) || "Generando…";
      for (const s of rows) {
        db.update(songs).set({ status: "generating", progress, updatedAt: now() }).where(eq(songs.id, s.id)).run();
      }
      continue;
    }

    if (task.status === 2) {
      const error = task.items[0]?.error ?? task.progress_text ?? (task.result || "La generación falló");
      for (const s of rows) {
        db.update(songs).set({ status: "failed", error: String(error).slice(0, 1000), progress: "", updatedAt: now() }).where(eq(songs.id, s.id)).run();
      }
      continue;
    }

    // Succeeded: one item per generated audio.
    const files = task.items.filter((i) => i.file);
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    for (const row of rows) {
      // Index by the row's variant, not by its position in `rows`: a concurrent sync may
      // already have finished variant 0, and `files[0]` would then land on variant 1.
      const item = files[row.variant];
      if (!item) {
        // Engine produced fewer variants than requested (e.g. batch limited on Mac).
        db.delete(songs).where(eq(songs.id, row.id)).run();
        continue;
      }
      try {
        const rawAudioFile = `${row.id}.raw.mp3`;
        const buf = await engine.downloadAudio(item.file);
        fs.writeFileSync(path.join(AUDIO_DIR, rawAudioFile), buf);
        db.update(songs).set({ progress: "✨ Post-producción", updatedAt: now() }).where(eq(songs.id, row.id)).run();
        const audioFile = await masterInto(row.id, rawAudioFile, `${row.id}.mp3`, row.masterPreset as MasterPreset);
        const metas = item.metas ?? {};
        db.update(songs)
          .set({
            status: row.voiceId ? "converting" : "done",
            progress: row.voiceId ? "Enviando a conversión de voz" : "",
            rawAudioFile,
            audioFile,
            bpm: typeof metas.bpm === "number" && metas.bpm >= 30 && metas.bpm < 300 ? metas.bpm : null,
            keyScale: typeof metas.keyscale === "string" && metas.keyscale !== "N/A" ? metas.keyscale : null,
            timeSignature: typeof metas.timesignature === "string" && metas.timesignature !== "N/A" ? metas.timesignature : null,
            duration: typeof metas.duration === "number" ? metas.duration : row.duration,
            style: row.style || item.prompt || row.style,
            lyrics: row.lyrics || item.lyrics || row.lyrics,
            updatedAt: now(),
          })
          .where(and(eq(songs.id, row.id)))
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(songs).set({ status: "failed", error: msg, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      }
    }
  }
}

/** Songs generated with a voice profile: submit them to the voice service and collect the result. */
async function syncVoiceConversion(): Promise<void> {
  const rows = db.select().from(songs).where(eq(songs.status, "converting")).all();
  if (rows.length === 0) return;
  fs.mkdirSync(AUDIO_DIR, { recursive: true });

  for (const row of rows) {
    try {
      if (!row.voiceJobId) {
        const v = row.voiceId ? getVoice(row.voiceId) : undefined;
        // Always convert the model's own output: on a re-conversion rawAudioFile already points at the converted mix.
        const modelRaw = path.join(AUDIO_DIR, `${row.id}.raw.mp3`);
        const src = fs.existsSync(modelRaw) ? modelRaw : row.rawAudioFile ? path.join(AUDIO_DIR, row.rawAudioFile) : audioPathFor(row);
        if (!v || !src) {
          db.update(songs).set({ status: "done", progress: "", error: "Voz no disponible; se conserva la voz original", updatedAt: now() }).where(eq(songs.id, row.id)).run();
          continue;
        }
        const job = await voice.submitConversion(src, voicePath(v), { autotune: row.autotune, keyScale: row.keyScale, refKind: voiceKind(v), options: parseConversionOptions(row.voiceOptions) });
        db.update(songs).set({ voiceJobId: job.job_id, progress: `🎤 En cola de conversión (#${job.queue_position})`, updatedAt: now() }).where(eq(songs.id, row.id)).run();
        continue;
      }

      const job = await voice.jobStatus(row.voiceJobId);
      if (!job) {
        // The voice service was restarted and lost the job: resubmit on the next sync.
        db.update(songs).set({ voiceJobId: null, progress: "🎤 Reenviando a conversión de voz", updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else if (job.status === "queued" || job.status === "running") {
        db.update(songs).set({ progress: `🎤 ${job.stage}`, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else if (job.status === "failed") {
        // Keep the song playable with the original vocals and surface the error.
        db.update(songs).set({ status: "done", progress: "", error: `Conversión de voz falló: ${job.error ?? "error desconocido"}`, updatedAt: now() }).where(eq(songs.id, row.id)).run();
      } else {
        const buf = await voice.downloadJobAudio(row.voiceJobId);
        const convertedRaw = `${row.id}.voice.raw.mp3`;
        fs.writeFileSync(path.join(AUDIO_DIR, convertedRaw), buf);
        db.update(songs).set({ progress: "✨ Post-producción", updatedAt: now() }).where(eq(songs.id, row.id)).run();
        const converted = await masterInto(row.id, convertedRaw, `${row.id}.voice.mp3`, row.masterPreset as MasterPreset);
        db.update(songs)
          .set({ status: "done", progress: "", originalAudioFile: row.originalAudioFile ?? row.audioFile, rawAudioFile: convertedRaw, audioFile: converted, error: null, updatedAt: now() })
          .where(eq(songs.id, row.id))
          .run();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.update(songs).set({ progress: `🎤 Servicio de voz no disponible: ${msg}`.slice(0, 300), updatedAt: now() }).where(eq(songs.id, row.id)).run();
    }
  }
}

/** Masters `rawFile` into `outFile`; on failure keeps the raw audio so the song stays playable. */
async function masterInto(songId: string, rawFile: string, outFile: string, preset: MasterPreset): Promise<string> {
  try {
    await masterAudio(path.join(AUDIO_DIR, rawFile), path.join(AUDIO_DIR, outFile), preset);
    return outFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(songs).set({ error: `Post-producción falló: ${msg.slice(0, 200)}`, updatedAt: now() }).where(eq(songs.id, songId)).run();
    fs.copyFileSync(path.join(AUDIO_DIR, rawFile), path.join(AUDIO_DIR, outFile));
    return outFile;
  }
}

/**
 * Post-production on demand, always from the raw model output:
 *   raw → [Apollo AI restoration] → [mastering preset] → audioFile
 * Either step can be skipped; both off restores the raw audio.
 */
export async function postProduce(id: string, opts: { enhance: boolean; preset: MasterPreset }): Promise<Song> {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done" || !song.audioFile) throw new Error("La canción aún no está lista");
  let rawAudioFile = song.rawAudioFile;
  if (!rawAudioFile) {
    // Songs generated before post-production existed: their current audio is the raw output.
    rawAudioFile = `${song.id}.raw.mp3`;
    fs.copyFileSync(path.join(AUDIO_DIR, song.audioFile), path.join(AUDIO_DIR, rawAudioFile));
    db.update(songs).set({ rawAudioFile, updatedAt: now() }).where(eq(songs.id, id)).run();
  }
  const raw = path.join(AUDIO_DIR, rawAudioFile);
  const out = path.join(AUDIO_DIR, song.audioFile);
  let source = raw;
  const tmp = path.join(AUDIO_DIR, `${song.id}.enhanced.wav`);
  try {
    if (opts.enhance) {
      fs.writeFileSync(tmp, await voice.enhanceAudio(raw));
      source = tmp;
    }
    await masterAudio(source, out, opts.preset);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  db.update(songs).set({ masterPreset: opts.preset, enhanced: opts.enhance, updatedAt: now() }).where(eq(songs.id, id)).run();
  return getSong(id)!;
}

/**
 * Re-runs the voice conversion of a finished song (e.g. toggling autotune, after cleaning the voice or with
 * other quality knobs). `options` replaces the stored knobs (null = back to the service defaults); omitted keeps them.
 */
export function reconvertVoice(id: string, opts: { autotune?: boolean; voiceId?: string; options?: ConversionOptions | null }): Song {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done") throw new Error("La canción aún no está lista");
  const voiceId = opts.voiceId ?? song.voiceId;
  if (!voiceId || !getVoice(voiceId)) throw new Error("Esta canción no tiene una voz asignada");
  if (!fs.existsSync(path.join(AUDIO_DIR, `${song.id}.raw.mp3`))) throw new Error("No se conserva el audio original del modelo para reconvertir");
  db.update(songs)
    .set({
      voiceId,
      autotune: opts.autotune ?? song.autotune,
      voiceOptions: opts.options === undefined ? song.voiceOptions : opts.options && Object.keys(opts.options).length ? JSON.stringify(opts.options) : null,
      status: "converting",
      voiceJobId: null,
      progress: "🎤 Reenviando a conversión de voz",
      error: null,
      updatedAt: now(),
    })
    .where(eq(songs.id, id))
    .run();
  return getSong(id)!;
}

/**
 * Drops the converted vocals and puts the song back to the model's own voice. The `.voice.*` files are
 * deleted; the model's output (`<id>.mp3` / `<id>.raw.mp3`) is untouched. Works on a song still converting:
 * its job is abandoned (the sync only follows rows in `converting`).
 */
export function removeVoice(id: string): Song {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (!song.voiceId && !song.originalAudioFile) throw new Error("Esta canción no tiene voz convertida");
  const modelMix = `${song.id}.mp3`;
  const modelRaw = `${song.id}.raw.mp3`;
  const audioFile = song.originalAudioFile && fs.existsSync(path.join(AUDIO_DIR, song.originalAudioFile)) ? song.originalAudioFile : fs.existsSync(path.join(AUDIO_DIR, modelMix)) ? modelMix : null;
  if (!audioFile) throw new Error("No se conserva el audio original del modelo");
  for (const f of [`${song.id}.voice.mp3`, `${song.id}.voice.raw.mp3`]) fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
  db.update(songs)
    .set({ voiceId: null, voiceJobId: null, autotune: false, status: "done", progress: "", error: null, audioFile, originalAudioFile: null, rawAudioFile: fs.existsSync(path.join(AUDIO_DIR, modelRaw)) ? modelRaw : song.rawAudioFile, updatedAt: now() })
    .where(eq(songs.id, id))
    .run();
  return getSong(id)!;
}

/** Turns a natural-language instruction into a concrete cover/repaint plan (Ollama, with a plain fallback). */
export async function planSongEdit(id: string, instruction: string, range: { start: number | null; end: number | null }): Promise<EditPlan> {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done" || !song.audioFile) throw new Error("La canción aún no está lista");
  const text = instruction.trim();
  if (!text) throw new Error("Escribe qué quieres cambiar.");
  const hasRange = range.start !== null || range.end !== null;
  if (await ollamaAvailable()) {
    return planEdit({ instruction: text, style: song.style, lyrics: song.lyrics, duration: song.duration, start: range.start, end: range.end });
  }
  // No LLM: a range means repaint with the instruction as caption; otherwise a cover with the instruction appended.
  return hasRange
    ? { op: "repaint", style: `${song.style}, ${text}`, lyrics: song.lyrics, strength: 0.75, start: range.start ?? 0, end: range.end ?? song.duration ?? -1, summary: "Regenerar el tramo con la instrucción como descripción." }
    : { op: "cover", style: `${song.style}, ${text}`, lyrics: song.lyrics, strength: 0.75, start: null, end: null, summary: "Regenerar la canción con la instrucción añadida al estilo." };
}

/** Submits the edit as a new song version linked to the original (same artist, album and voice). */
export async function editSong(id: string, instruction: string, plan: EditPlan): Promise<Song[]> {
  const song = getSong(id);
  if (!song) throw new Error("No existe");
  if (song.status !== "done" || !song.audioFile) throw new Error("La canción aún no está lista");
  // Always edit from the unprocessed model output, without the converted voice.
  const srcFile = song.originalAudioFile ? `${song.id}.raw.mp3` : song.rawAudioFile ?? song.audioFile;
  const srcPath = path.join(AUDIO_DIR, fs.existsSync(path.join(AUDIO_DIR, srcFile)) ? srcFile : song.audioFile);
  const task = await engine.releaseEditTask(
    {
      task_type: plan.op,
      prompt: plan.style,
      lyrics: song.instrumental ? "[Instrumental]" : plan.lyrics,
      vocal_language: song.vocalLanguage,
      model: song.model,
      audio_cover_strength: plan.strength,
      repainting_start: plan.start ?? 0,
      repainting_end: plan.end ?? -1,
      batch_size: 1,
    },
    { buffer: fs.readFileSync(srcPath), filename: path.basename(srcPath) },
  );
  const ts = now();
  const siblings = db.select({ n: songs.id }).from(songs).where(eq(songs.parentId, song.parentId ?? song.id)).all().length;
  const row = {
    id: randomUUID(),
    taskId: task.task_id,
    variant: 0,
    title: song.title.replace(/ · edición \d+$/, "") + ` · edición ${siblings + 1}`,
    mode: song.mode,
    description: song.description,
    style: plan.style,
    lyrics: song.instrumental ? "[Instrumental]" : plan.lyrics,
    instrumental: song.instrumental,
    duration: song.duration,
    vocalLanguage: song.vocalLanguage,
    model: song.model,
    voiceId: song.voiceId,
    autotune: song.autotune,
    masterPreset: "off" as const,
    artistId: song.artistId,
    albumId: song.albumId,
    parentId: song.parentId ?? song.id,
    editOp: plan.op,
    editInstruction: instruction.trim(),
    status: "queued" as const,
    progress: task.queue_position ? `En cola (#${task.queue_position})` : "En cola",
    createdAt: ts,
    updatedAt: ts,
  };
  db.insert(songs).values(row).run();
  return db.select().from(songs).where(eq(songs.id, row.id)).all();
}
