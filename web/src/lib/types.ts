import type { Album, Artist, Song, Voice } from "@/db/schema";

export type SongDTO = Song;
export type VoiceDTO = Voice;
export type AlbumDTO = Album;
export type ArtistDTO = Artist & { songCount: number; albumCount: number; voiceCount: number };

/** Library scope: a specific artist, songs without artist, or everything. */
export type Scope = { kind: "all" } | { kind: "none" } | { kind: "artist"; id: string } | { kind: "market" };

/** Prefill for the create panel (e.g. from a market idea). */
export type CreateDraft = { title?: string; description?: string; style?: string; mode?: "simple" | "custom"; artistId?: string | null; /** Banner text, e.g. where the idea came from. */ label?: string; nonce: number };

export type EngineStatus = {
  engine: { online: boolean; version: string | null; models: { name: string; is_default?: boolean }[]; defaultModel: string | null };
  ollama: { online: boolean; model: string | null };
  voice: { online: boolean; device: string | null; modelsLoaded: boolean };
  video?: { online: boolean; device: string | null; freeGb: number | null; busy: boolean };
};

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "中文" },
];

export function coverGradient(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 60 + (h % 90)) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 45%), hsl(${b} 75% 35%))`;
}

export function fmtTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Models the engine can load on demand (ACESTEP_ON_DEMAND_MODEL_LOAD=true). */
export const KNOWN_MODELS: { name: string; label: string; hint: string }[] = [
  { name: "acestep-v15-turbo", label: "Turbo 2B", hint: "rápido, calidad buena" },
  { name: "acestep-v15-xl-turbo", label: "XL Turbo 4B", hint: "más calidad y menos artefactos · 2-3× más lento · descarga 9 GB la 1ª vez" },
  { name: "acestep-v15-xl-sft", label: "XL SFT 4B · 50 pasos", hint: "máxima calidad · muy lento en Mac" },
];
