import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const SONG_STATUSES = ["queued", "generating", "converting", "done", "failed"] as const;
export type SongStatus = (typeof SONG_STATUSES)[number];

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  variant: integer("variant").notNull().default(0),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["simple", "custom"] }).notNull(),
  description: text("description").notNull().default(""),
  style: text("style").notNull().default(""),
  lyrics: text("lyrics").notNull().default(""),
  instrumental: integer("instrumental", { mode: "boolean" }).notNull().default(false),
  duration: real("duration"),
  vocalLanguage: text("vocal_language").notNull().default("es"),
  model: text("model"),
  seed: text("seed"),
  status: text("status", { enum: SONG_STATUSES }).notNull().default("queued"),
  progress: text("progress").notNull().default(""),
  error: text("error"),
  artistId: text("artist_id"),
  albumId: text("album_id"),
  parentId: text("parent_id"),
  editOp: text("edit_op"),
  editInstruction: text("edit_instruction"),
  audioFile: text("audio_file"),
  originalAudioFile: text("original_audio_file"),
  rawAudioFile: text("raw_audio_file"),
  masterPreset: text("master_preset").notNull().default("off"),
  enhanced: integer("enhanced", { mode: "boolean" }).notNull().default(false),
  voiceId: text("voice_id"),
  voiceJobId: text("voice_job_id"),
  /** Pitch-correct the sung voice during conversion (Seed-VC follows a tuned F0 curve). */
  autotune: integer("autotune", { mode: "boolean" }).notNull().default(false),
  /** Conversion quality knobs sent to the voice service (JSON, see lib/voice-options.ts); null = service defaults. */
  voiceOptions: text("voice_options"),
  /** Voice to compare the generated singer with (CAMPPlus cosine similarity, scored once the song is done). */
  voiceMatchId: text("voice_match_id"),
  voiceSimilarity: real("voice_similarity"),
  /** Stills video (sequence of Pixar-style images + Ken Burns): none | queued | rendering | done | failed. */
  videoStatus: text("video_status").notNull().default("none"),
  videoJobId: text("video_job_id"),
  videoFile: text("video_file"),
  videoProgress: text("video_progress").notNull().default(""),
  videoError: text("video_error"),
  /** Storyboard sent to the video service (JSON: character + scenes with prompt/duration/section). */
  storyboard: text("storyboard"),
  bpm: integer("bpm"),
  keyScale: text("key_scale"),
  timeSignature: text("time_signature"),
  generationInfo: text("generation_info"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type Song = typeof songs.$inferSelect;
export type NewSong = typeof songs.$inferInsert;

export const voices = sqliteTable("voices", {
  id: text("id").primaryKey(),
  artistId: text("artist_id"),
  name: text("name").notNull(),
  file: text("file").notNull(),
  durationSec: real("duration_sec"),
  /** Pitch profile measured from the reference (speaking): median F0 and the comfortable singing range. */
  f0MedianHz: real("f0_median_hz"),
  singLowHz: real("sing_low_hz"),
  singHighHz: real("sing_high_hz"),
  /** Vocal register key (see voice-register.ts): detected from the pitch, editable by the user. */
  register: text("register"),
  /** Full analysis as returned by the voice service (JSON, see VoiceProfile in voice-register.ts). */
  profile: text("profile"),
  /** Studio-cleaned copy of the recording (denoise, EQ, compression); `useClean` picks which one is used. */
  cleanFile: text("clean_file"),
  useClean: integer("use_clean", { mode: "boolean" }).notNull().default(false),
  /** Sculpted copy of the active reference (formants, pitch, air via Praat) so the voice is one of a kind;
   *  `useSculpt` picks it, `sculptParams` is the JSON {formant, pitch, brightness} it was made with. */
  sculptFile: text("sculpt_file"),
  sculptParams: text("sculpt_params"),
  useSculpt: integer("use_sculpt", { mode: "boolean" }).notNull().default(false),
  /** "speech" = the person talking; "singing" = a sung reference (e.g. extracted from a generated song). */
  kind: text("kind").notNull().default("speech"),
  /** Song this synthetic singer was extracted from, when kind = singing. */
  sourceSongId: text("source_song_id"),
  createdAt: integer("created_at").notNull(),
});

export type Voice = typeof voices.$inferSelect;

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull().default("🎤"),
  style: text("style").notNull().default(""),
  description: text("description").notNull().default(""),
  vocalLanguage: text("vocal_language").notNull().default("es"),
  defaultVoiceId: text("default_voice_id"),
  /** Portrait generated with the OpenAI image API from `imagePrompt` (file under data/images/artists). */
  imageFile: text("image_file"),
  imagePrompt: text("image_prompt"),
  /** ACE-Step LoRA trained on the artist's songs: none | preparing | training | done | failed (see lib/lora.ts). */
  loraStatus: text("lora_status").notNull().default("none"),
  loraPath: text("lora_path"),
  loraProgress: text("lora_progress").notNull().default(""),
  loraError: text("lora_error"),
  loraTag: text("lora_tag"),
  createdAt: integer("created_at").notNull(),
});

export const albums = sqliteTable("albums", {
  id: text("id").primaryKey(),
  artistId: text("artist_id").notNull(),
  name: text("name").notNull(),
  /** Cover generated with the OpenAI image API from `imagePrompt` (file under data/images/albums). */
  imageFile: text("image_file"),
  imagePrompt: text("image_prompt"),
  createdAt: integer("created_at").notNull(),
});

export type Artist = typeof artists.$inferSelect;
export type Album = typeof albums.$inferSelect;

export const kvCache = sqliteTable("kv_cache", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: integer("created_at").notNull(),
});
