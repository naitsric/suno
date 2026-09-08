import { and, desc, eq, isNull } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { artists, songs, voices, type Artist, type Voice } from "@/db/schema";
import * as service from "./voice";
import { isRegister, parseVoiceProfile, voiceBrief, type Register, type VoiceProfile } from "./voice-register";

const VOICES_DIR = process.env.VOICES_DIR ?? "./data/voices";

export function listVoices(artistId?: string | null): Voice[] {
  const q = db.select().from(voices);
  return (artistId ? q.where(eq(voices.artistId, artistId)) : q).orderBy(desc(voices.createdAt)).all();
}

export function getVoice(id: string): Voice | undefined {
  return db.select().from(voices).where(eq(voices.id, id)).get();
}

/** The file used as reference: the cleaned copy when the user enabled it, else the original recording. */
export function voicePath(v: Voice) {
  return path.join(VOICES_DIR, v.useClean && v.cleanFile ? v.cleanFile : v.file);
}

export function voiceOriginalPath(v: Voice) {
  return path.join(VOICES_DIR, v.file);
}

/**
 * Studio cleanup of the recording via the voice service. Keeps the original; stores `<id>.clean.wav`,
 * switches the voice to it and re-measures the profile. Reversible with setUseClean(id, false).
 */
export async function cleanVoice(id: string): Promise<{ voice: Voice; info: Awaited<ReturnType<typeof service.cleanReference>>["info"] }> {
  const v = getVoice(id);
  if (!v) throw new Error("La voz no existe");
  const { wav, info } = await service.cleanReference(voiceOriginalPath(v));
  const cleanFile = `${id}.clean.wav`;
  fs.writeFileSync(path.join(VOICES_DIR, cleanFile), wav);
  db.update(voices).set({ cleanFile, useClean: true, profile: null }).where(eq(voices.id, id)).run();
  return { voice: await analyzeVoice(getVoice(id)!), info };
}

/** Switches between the cleaned and the original recording; the pitch profile is re-measured on the active one. */
export async function setUseClean(id: string, useClean: boolean): Promise<Voice> {
  const v = getVoice(id);
  if (!v) throw new Error("La voz no existe");
  if (useClean && !v.cleanFile) throw new Error("Esta voz no tiene versión retocada");
  db.update(voices).set({ useClean, profile: null }).where(eq(voices.id, id)).run();
  return analyzeVoice(getVoice(id)!);
}

/**
 * Measures the pitch profile of a voice with the voice service and stores it (median F0, register,
 * comfortable singing range). Best effort: returns the voice unchanged when the service is offline.
 * A user-chosen register is kept; only the measured numbers are refreshed.
 */
export async function analyzeVoice(v: Voice): Promise<Voice> {
  try {
    return await measureVoice(v);
  } catch (err) {
    console.warn(`[voices] análisis de tono omitido para ${v.id}: ${err instanceof Error ? err.message : err}`);
    return v;
  }
}

/** Same as analyzeVoice but propagates the service error (for explicit re-analysis from the UI). */
export async function measureVoice(v: Voice): Promise<Voice> {
  const p = await service.analyzeReference(voicePath(v), voiceKind(v));
  const set: Partial<Voice> = { f0MedianHz: p.median_hz, singLowHz: p.sing_low_hz, singHighHz: p.sing_high_hz, profile: JSON.stringify(p) };
  if (!v.register && isRegister(p.register)) set.register = p.register;
  db.update(voices).set(set).where(eq(voices.id, v.id)).run();
  return getVoice(v.id) ?? v;
}

/** Analyses voices that were saved before pitch profiles existed (or while the service was off). */
export async function ensureVoiceProfiles(list: Voice[]): Promise<Voice[]> {
  const missing = list.filter((v) => v.profile === null);
  if (missing.length === 0 || !(await service.health())) return list;
  const analysed = new Map(await Promise.all(missing.map(async (v) => [v.id, await analyzeVoice(v)] as const)));
  return list.map((v) => analysed.get(v.id) ?? v);
}

export function voiceKind(v: Voice): service.VoiceKind {
  return v.kind === "singing" ? "singing" : "speech";
}

/**
 * A synthetic singer for an artist: the cleanest 30 s of the vocals of a generated song, saved as a *sung*
 * reference. Every song converted with it gets the same voice, and the conversion no longer has to
 * imagine how a speaking voice sings. Becomes the artist's default voice.
 */
export async function createVoiceFromSong(songId: string, name?: string): Promise<{ voice: Voice; info: Awaited<ReturnType<typeof service.extractReference>>["info"] }> {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) throw new Error("La canción no existe");
  if (song.status !== "done" || !song.audioFile) throw new Error("La canción aún no está lista");
  const audioDir = process.env.AUDIO_DIR ?? "./data/audio";
  // The model's own output (before any voice conversion) is the singer we want to capture.
  const candidates = [`${song.id}.raw.mp3`, song.originalAudioFile, song.rawAudioFile, song.audioFile].filter((f): f is string => !!f);
  const src = candidates.map((f) => path.join(audioDir, f)).find((f) => fs.existsSync(f));
  if (!src) throw new Error("No se encuentra el audio de la canción");
  const { wav, info } = await service.extractReference(src);
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const id = randomUUID();
  const file = `${id}.wav`;
  fs.writeFileSync(path.join(VOICES_DIR, file), wav);
  const row: Voice = {
    id,
    artistId: song.artistId,
    name: (name ?? "").trim() || `Voz de «${song.title.replace(/ · edición \d+$/, "")}»`,
    file,
    durationSec: info ? Math.round((info.end_sec - info.start_sec) * 10) / 10 : null,
    f0MedianHz: null,
    singLowHz: null,
    singHighHz: null,
    register: null,
    profile: null,
    cleanFile: null,
    useClean: false,
    kind: "singing",
    sourceSongId: song.id,
    createdAt: Date.now(),
  };
  db.insert(voices).values(row).run();
  if (song.artistId) db.update(artists).set({ defaultVoiceId: id }).where(eq(artists.id, song.artistId)).run();
  return { voice: await analyzeVoice(row), info };
}

export function voiceRegister(v: Voice): Register | null {
  return isRegister(v.register) ? v.register : null;
}

export function voiceProfile(v: Voice): VoiceProfile | null {
  return parseVoiceProfile(v);
}

/** Spanish summary (register, range, timbre) of an artist's default voice for LLM prompts; null without a voice. */
export async function artistVoiceBrief(artist: Artist | null): Promise<string | null> {
  if (!artist?.defaultVoiceId) return null;
  let v = getVoice(artist.defaultVoiceId);
  if (!v) return null;
  if (v.profile === null) v = await analyzeVoice(v);
  const register = voiceRegister(v);
  return register ? voiceBrief(register, voiceProfile(v)) : null;
}

/** Stores a reference recording normalised to mono 44.1 kHz WAV (max 30 s) and measures its pitch profile. */
export async function saveVoice(name: string, input: Buffer, originalName: string, artistId: string | null = null): Promise<Voice> {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const id = randomUUID();
  const ext = path.extname(originalName || "").toLowerCase() || ".webm";
  const raw = path.join(VOICES_DIR, `${id}.raw${ext}`);
  const wav = `${id}.wav`;
  fs.writeFileSync(raw, input);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-ac", "1", "-ar", "44100", "-t", "30", "-af", "loudnorm=I=-18:TP=-1.5", path.join(VOICES_DIR, wav)]);
  } finally {
    fs.rmSync(raw, { force: true });
  }
  let durationSec: number | null = null;
  try {
    durationSec = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(VOICES_DIR, wav)]).toString().trim());
  } catch {
    /* optional */
  }
  if (durationSec !== null && durationSec < 3) {
    fs.rmSync(path.join(VOICES_DIR, wav), { force: true });
    throw new Error("La grabación es demasiado corta: graba al menos 10 segundos.");
  }
  const row: Voice = { id, artistId, name: name.trim() || "Mi voz", file: wav, durationSec, f0MedianHz: null, singLowHz: null, singHighHz: null, register: null, profile: null, cleanFile: null, useClean: false, kind: "speech", sourceSongId: null, createdAt: Date.now() };
  db.insert(voices).values(row).run();
  if (artistId) {
    // First voice of an artist becomes its default.
    db.update(artists).set({ defaultVoiceId: id }).where(and(eq(artists.id, artistId), isNull(artists.defaultVoiceId))).run();
  }
  return analyzeVoice(row);
}

export function deleteVoice(id: string) {
  const v = getVoice(id);
  if (!v) return false;
  fs.rmSync(voiceOriginalPath(v), { force: true });
  if (v.cleanFile) fs.rmSync(path.join(VOICES_DIR, v.cleanFile), { force: true });
  db.delete(voices).where(eq(voices.id, id)).run();
  db.update(artists).set({ defaultVoiceId: null }).where(eq(artists.defaultVoiceId, id)).run();
  return true;
}

/** Renames a voice, moves it to another artist (or to no artist) or overrides its register. */
export function updateVoice(id: string, patch: { name?: string; artistId?: string | null; register?: Register }): Voice {
  const v = getVoice(id);
  if (!v) throw new Error("La voz no existe");
  if (patch.artistId && !db.select().from(artists).where(eq(artists.id, patch.artistId)).get()) throw new Error("El artista no existe");
  const set: Partial<Voice> = {};
  if (patch.name !== undefined) set.name = patch.name.trim() || v.name;
  if (patch.artistId !== undefined) set.artistId = patch.artistId;
  if (patch.register !== undefined) set.register = patch.register;
  if (Object.keys(set).length) db.update(voices).set(set).where(eq(voices.id, id)).run();
  if (patch.artistId !== undefined && patch.artistId !== v.artistId) {
    // Leaving an artist clears it as their default; joining one fills an empty default.
    db.update(artists).set({ defaultVoiceId: null }).where(eq(artists.defaultVoiceId, id)).run();
    if (patch.artistId) db.update(artists).set({ defaultVoiceId: id }).where(and(eq(artists.id, patch.artistId), isNull(artists.defaultVoiceId))).run();
  }
  return getVoice(id)!;
}
