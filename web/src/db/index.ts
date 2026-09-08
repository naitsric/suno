import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_PATH ?? "./data/suno.db";

const globalForDb = globalThis as unknown as { __sunoSqlite?: Database.Database };

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

/** Idempotent schema setup; runs on every module load so dev hot-reloads pick up new columns. */
function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      variant INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '',
      lyrics TEXT NOT NULL DEFAULT '',
      instrumental INTEGER NOT NULL DEFAULT 0,
      duration REAL,
      vocal_language TEXT NOT NULL DEFAULT 'es',
      model TEXT,
      seed TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress TEXT NOT NULL DEFAULT '',
      error TEXT,
      audio_file TEXT,
      bpm INTEGER,
      key_scale TEXT,
      time_signature TEXT,
      generation_info TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS songs_task_id ON songs(task_id);
    CREATE INDEX IF NOT EXISTS songs_created_at ON songs(created_at);
    CREATE TABLE IF NOT EXISTS voices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      duration_sec REAL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🎤',
      style TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      vocal_language TEXT NOT NULL DEFAULT 'es',
      default_voice_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      artist_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);
    CREATE TABLE IF NOT EXISTS kv_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Additive migrations for databases created before the voice feature.
  const cols = new Set((sqlite.prepare("PRAGMA table_info(songs)").all() as { name: string }[]).map((c) => c.name));
  for (const [col, ddl] of [
    ["original_audio_file", "original_audio_file TEXT"],
    ["voice_id", "voice_id TEXT"],
    ["voice_job_id", "voice_job_id TEXT"],
    ["raw_audio_file", "raw_audio_file TEXT"],
    ["master_preset", "master_preset TEXT NOT NULL DEFAULT 'off'"],
    ["enhanced", "enhanced INTEGER NOT NULL DEFAULT 0"],
    ["artist_id", "artist_id TEXT"],
    ["album_id", "album_id TEXT"],
    ["parent_id", "parent_id TEXT"],
    ["edit_op", "edit_op TEXT"],
    ["edit_instruction", "edit_instruction TEXT"],
    ["autotune", "autotune INTEGER NOT NULL DEFAULT 0"],
    ["video_status", "video_status TEXT NOT NULL DEFAULT 'none'"],
    ["video_job_id", "video_job_id TEXT"],
    ["video_file", "video_file TEXT"],
    ["video_progress", "video_progress TEXT NOT NULL DEFAULT ''"],
    ["video_error", "video_error TEXT"],
    ["storyboard", "storyboard TEXT"],
  ] as const) {
    if (!cols.has(col)) sqlite.exec(`ALTER TABLE songs ADD COLUMN ${ddl}`);
  }
  const voiceCols = new Set((sqlite.prepare("PRAGMA table_info(voices)").all() as { name: string }[]).map((c) => c.name));
  for (const [col, ddl] of [
    ["artist_id", "artist_id TEXT"],
    ["f0_median_hz", "f0_median_hz REAL"],
    ["sing_low_hz", "sing_low_hz REAL"],
    ["sing_high_hz", "sing_high_hz REAL"],
    ["register", "register TEXT"],
    ["profile", "profile TEXT"],
    ["clean_file", "clean_file TEXT"],
    ["use_clean", "use_clean INTEGER NOT NULL DEFAULT 0"],
    ["kind", "kind TEXT NOT NULL DEFAULT 'speech'"],
    ["source_song_id", "source_song_id TEXT"],
  ] as const) {
    if (!voiceCols.has(col)) sqlite.exec(`ALTER TABLE voices ADD COLUMN ${ddl}`);
  }
  for (const table of ["artists", "albums"]) {
    const cols = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("image_file")) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN image_file TEXT`);
    if (!cols.has("image_prompt")) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN image_prompt TEXT`);
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS songs_artist ON songs(artist_id)");
  // Songs generated before post-production existed were never processed.
  sqlite.exec("UPDATE songs SET master_preset = 'off' WHERE raw_audio_file IS NULL AND master_preset <> 'off'");
}

const sqlite = globalForDb.__sunoSqlite ?? open();
if (process.env.NODE_ENV !== "production") globalForDb.__sunoSqlite = sqlite;
ensureSchema(sqlite);

export const db = drizzle(sqlite, { schema });
