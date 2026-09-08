/**
 * Reference songs: turn the measured analysis of a YouTube video (voice service `/reference-analysis`)
 * into a style prompt for ACE-Step. Two writers: a deterministic tag list built from the measurements
 * (always available) and an Ollama pass that writes a caption/summary on top of it when it is online.
 */
import { randomUUID } from "node:crypto";
import { cacheGet, cacheSet } from "./cache";
import { chatJson, ollamaAvailable } from "./ollama";
import * as service from "./voice";

const CACHE_MS = 30 * 24 * 3600_000; // the video does not change; re-analysing costs 2 min of GPU

export type Scored = { label: string; score: number; /** Fraction of the windows where the label ranked top 3. */ hits?: number };
export type ScoredInstrument = Scored & { group: "melodic" | "percussion" | "bass" };
export type ReferenceSection = { start: number; end: number; energy: "low" | "mid" | "high"; role: "intro" | "outro" | "peak" | "section"; level_db: number };
export type ReferenceAnalysis = {
  source: { id: string | null; url: string | null; title: string | null; channel?: string | null; duration: number | null; tags?: string[]; description?: string; artist?: string | null; track?: string | null; upload_date?: string | null };
  duration: number;
  bpm: number;
  bpm_alternatives: number[];
  pulse_clarity: number;
  key: string;
  key_confidence: number;
  loudness_dbfs: number;
  dynamic_range_db: number;
  brightness_hz: number;
  onsets_per_sec: number;
  spectrum: { sub_bass: number; bass: number; mids: number; highs: number; air: number };
  energy_curve: number[];
  energy_step_s: number;
  structure: ReferenceSection[];
  stems: { drums: number; bass: number; other: number; vocals: number };
  vocals: {
    present: boolean;
    activity: number;
    best_window: [number, number];
    pitch?: { median_hz: number; p10_hz: number; p90_hz: number; median_note: string; low_note: string; high_note: string; register: string; gender_guess: "male" | "female" | "ambiguous" } | null;
    /** CLAP man/woman contrast on the vocal stem, tie-broken by pitch. */
    gender?: "male" | "female" | "ambiguous";
    gender_confidence?: number;
    language?: string;
    language_probability?: number;
    transcript_snippet?: string;
  };
  tags: { genres: Scored[]; moods: Scored[]; instruments: ScoredInstrument[]; vocals: Scored[]; production: Scored[] };
  timings: Record<string, number>;
};

export type ReferencePrompt = {
  /** Comma-separated tags for the style field. */
  style: string;
  /** One-paragraph caption in the ACE-Step musicians-guide style. */
  caption: string;
  /** Spanish: what the reference sounds like and what was taken from it. */
  summary: string;
  /** Spanish: how the reference is built over time (intro, first peak, breaks). */
  structure: string;
  bpm: number;
  keyScale: string | null;
  source: "ollama" | "rules";
};

export type ReferenceResult = { analysis: ReferenceAnalysis; prompt: ReferencePrompt; cached: boolean };

export function youtubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Analyses (or reuses) a YouTube reference and writes the prompt for it. */
export async function analyzeYoutubeReference(url: string, opts: { voiceBrief?: string | null; artistStyle?: string | null; refresh?: boolean; token?: string } = {}): Promise<ReferenceResult> {
  const id = youtubeId(url);
  if (!id) throw new Error("No parece una URL de YouTube (se espera watch?v=…, youtu.be/… o shorts/…)");
  const key = `reference:youtube:${id}`;
  let analysis = opts.refresh ? null : cacheGet<ReferenceAnalysis>(key, CACHE_MS)?.value ?? null;
  const cached = analysis !== null;
  if (!analysis) {
    if (!(await service.health())) throw new Error("El servicio de voz está apagado: ejecuta make voice");
    analysis = (await service.analyzeMusicReference({ url: `https://www.youtube.com/watch?v=${id}`, token: opts.token ?? randomUUID() })) as unknown as ReferenceAnalysis;
    cacheSet(key, analysis);
  }
  const prompt = await writeReferencePrompt(analysis, opts);
  return { analysis, prompt, cached };
}

/** Deterministic tags from the measurements: the fallback and the skeleton the LLM pass starts from. */
export function buildReferenceTags(a: ReferenceAnalysis, opts: { voiceBrief?: string | null } = {}): { tags: string[]; vocalTags: string[] } {
  // Keep a label when it scores close to the leader AND shows up in enough windows: a zero-shot
  // vocabulary always has a nearest label, so weak runner-ups are usually the model guessing.
  const pick = (list: Scored[], n: number, minShare: number, minHits = 0) => {
    const top = list[0]?.score ?? 0;
    return list.filter((s, i) => i < n && s.score >= top * minShare && (s.hits ?? 1) >= minHits).map((s) => s.label);
  };
  const tags: string[] = [];
  tags.push(...pick(a.tags.genres, 2, 0.45));
  tags.push(...pick(a.tags.moods, 2, 0.5));
  const byGroup = (g: ScoredInstrument["group"]) => a.tags.instruments.filter((s) => s.group === g);
  tags.push(...pick(byGroup("melodic"), 3, 0.4, 0.5), ...pick(byGroup("percussion"), 1, 0), ...pick(byGroup("bass"), 1, 0));
  const vocalTags: string[] = [];
  if (!a.vocals.present) vocalTags.push("instrumental");
  else if (!opts.voiceBrief) {
    const g = a.vocals.gender ?? a.vocals.pitch?.gender_guess;
    const clap = a.tags.vocals.filter((s) => !/^(male|female) vocals$|duet/.test(s.label)).slice(0, 2).map((s) => s.label);
    vocalTags.push(g === "male" ? "male vocals" : g === "female" ? "female vocals" : "vocals");
    if (a.vocals.pitch) vocalTags.push(`${a.vocals.pitch.register} vocal register`);
    vocalTags.push(...clap);
  }
  tags.push(...vocalTags);
  const prod = a.tags.production[0];
  if (prod && prod.score >= 0.25) tags.push(prod.label);
  tags.push(`${a.bpm} bpm`);
  if (a.key !== "unknown" && a.key_confidence >= 0.3) tags.push(a.key);
  if (a.dynamic_range_db >= 12) tags.push("dynamic");
  else if (a.loudness_dbfs > -14) tags.push("loud and dense");
  return { tags: dedupe(tags), vocalTags };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = t.toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Spanish description of the section map ("intro de 12 s, primer pico a 0:48…"). */
export function describeStructure(a: ReferenceAnalysis): string {
  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  const parts: string[] = [];
  const intro = a.structure.find((s) => s.role === "intro");
  if (intro) parts.push(`intro de ${Math.round(intro.end - intro.start)} s`);
  const peaks = a.structure.filter((s) => s.role === "peak");
  if (peaks.length) parts.push(`${peaks.length} tramo${peaks.length > 1 ? "s" : ""} de máxima energía (el primero en ${fmt(peaks[0].start)})`);
  const lows = a.structure.filter((s) => s.role === "section" && s.energy === "low");
  if (lows.length) parts.push(`${lows.length} bajada${lows.length > 1 ? "s" : ""} de energía`);
  const outro = a.structure.find((s) => s.role === "outro");
  if (outro) parts.push(`outro de ${Math.round(outro.end - outro.start)} s`);
  return parts.length ? `${fmt(a.duration)} en total: ${parts.join(", ")}.` : `${fmt(a.duration)} en total.`;
}

const SYSTEM = `Eres un productor musical. Recibes el ANÁLISIS MEDIDO de una canción de referencia (tempo, tonalidad, energía, estructura, peso de cada stem, voz, idioma y etiquetas de género/mood/instrumentos con puntuación) y escribes el prompt de estilo para un modelo de generación musical (ACE-Step), que entiende tags en inglés y una descripción corta.
Responde SOLO con JSON válido con esta forma exacta:
{"style": string, "caption": string, "summary": string, "structure": string}
Reglas:
- "style": 12–20 tags en inglés separados por coma, del más al menos importante: género y subgénero (1–2), mood (1–2), 3–5 instrumentos, tipo y timbre de voz, "<N> bpm", tonalidad, producción/época, energía. Usa lo que dicen las MEDIDAS; el tempo y la tonalidad medidos tal cual (sin redondear a otro número).
- Instrumentos: las etiquetas medidas son "la más parecida" de un vocabulario cerrado, con puntuación y presencia (% de ventanas). Elige 3–5 entre las de mayor puntuación Y presencia, no copies la lista entera, y traduce una etiqueta improbable al instrumento que ese género usa de verdad (p. ej. mandolin/banjo/ukulele en un reggaetón = acoustic guitar; saxophone en un trap = synth lead). Añade el instrumento típico del género solo si es indiscutible (808 bass y dembow beat en reggaetón).
- "caption": un párrafo en inglés de 40–70 palabras que describa cómo suena (como se lo dirías a músicos de sesión): género, instrumentación, groove, voz, producción, atmósfera, energía y cómo evoluciona.
- "summary": 2–3 frases en español para el usuario: qué es la referencia (género, instrumentos, voz, tempo) y qué se ha tomado de ella.
- "structure": 1–2 frases en español sobre cómo está construida en el tiempo (intro, cuándo llega el primer pico, bajadas, final) para que la letra pueda imitarla.
- No menciones el nombre del artista ni el título de la referencia en "style" ni en "caption": el modelo no imita artistas, describe el sonido.
- Si se indica una VOZ QUE CANTARÁ, describe esa voz (género vocal, registro, timbre) y no la de la referencia.
- Si la referencia no tiene voz, incluye "instrumental".`;

export async function writeReferencePrompt(a: ReferenceAnalysis, opts: { voiceBrief?: string | null; artistStyle?: string | null } = {}): Promise<ReferencePrompt> {
  const { tags, vocalTags } = buildReferenceTags(a, opts);
  const keyScale = a.key !== "unknown" && a.key_confidence >= 0.3 ? a.key : null;
  const rules: ReferencePrompt = {
    style: tags.join(", "),
    caption: "",
    summary: summarize(a, opts),
    structure: describeStructure(a),
    bpm: a.bpm,
    keyScale,
    source: "rules",
  };
  if (!(await ollamaAvailable())) return rules;
  const fmt = (list: Scored[]) => list.map((s) => `${s.label} (${Math.round(s.score * 100)}%)`).join(", ");
  const v = a.vocals;
  const user = [
    `Referencia: ${a.source.title ?? "(sin título)"}${a.source.channel ? ` · canal ${a.source.channel}` : ""}${a.source.tags?.length ? ` · etiquetas del video: ${a.source.tags.slice(0, 10).join(", ")}` : ""}`,
    `Duración ${Math.round(a.duration)} s · ${a.bpm} bpm (claridad de pulso ${Math.round(a.pulse_clarity * 100)}%${a.bpm_alternatives.length ? `, alternativas ${a.bpm_alternatives.join("/")}` : ""}) · tonalidad ${a.key} (confianza ${Math.round(a.key_confidence * 100)}%)`,
    `Sonoridad ${a.loudness_dbfs} dBFS · rango dinámico ${a.dynamic_range_db} dB · brillo (centroide) ${a.brightness_hz} Hz · ${a.onsets_per_sec} ataques/s`,
    `Espectro: sub ${pct(a.spectrum.sub_bass)}, graves ${pct(a.spectrum.bass)}, medios ${pct(a.spectrum.mids)}, agudos ${pct(a.spectrum.highs)}, aire ${pct(a.spectrum.air)}`,
    `Peso de cada stem: batería ${pct(a.stems.drums)}, bajo ${pct(a.stems.bass)}, resto (armonía/melodía) ${pct(a.stems.other)}, voz ${pct(a.stems.vocals)}`,
    v.present
      ? `Voz: presente el ${Math.round(v.activity * 100)}% del tiempo; género ${v.gender ?? "desconocido"} (confianza ${Math.round((v.gender_confidence ?? 0) * 100)}%)${v.pitch ? `; mediana ${v.pitch.median_note} (${v.pitch.median_hz} Hz), rango ${v.pitch.low_note}–${v.pitch.high_note}, registro ${v.pitch.register}` : ""}${v.language ? `; idioma ${v.language} (${Math.round((v.language_probability ?? 0) * 100)}%)` : ""}${v.transcript_snippet ? `; fragmento de letra: "${v.transcript_snippet.slice(0, 200)}"` : ""}`
      : "Voz: no hay (instrumental)",
    `Géneros (CLAP): ${fmt(a.tags.genres)}`,
    `Moods: ${fmt(a.tags.moods)}`,
    `Instrumentos melódicos/armónicos (stem sin batería, bajo ni voz): ${fmt(a.tags.instruments.filter((s) => s.group === "melodic"))}`,
    `Percusión (stem de batería): ${fmt(a.tags.instruments.filter((s) => s.group === "percussion"))} · Bajo (stem de bajo): ${fmt(a.tags.instruments.filter((s) => s.group === "bass"))}`,
    v.present ? `Estilo vocal: ${fmt(a.tags.vocals)}` : "",
    `Producción: ${fmt(a.tags.production)}`,
    `Estructura: ${describeStructure(a)} Secciones: ${a.structure.map((s) => `${s.role} ${Math.round(s.start)}–${Math.round(s.end)} s (${s.energy})`).join("; ")}`,
    `Tags deterministas de partida: ${tags.join(", ")}`,
    opts.voiceBrief ? `VOZ QUE CANTARÁ: ${opts.voiceBrief}` : "",
    opts.artistStyle ? `Estilo habitual del artista (solo como contexto, manda la referencia): ${opts.artistStyle}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const p = await chatJson<ReferencePrompt>(SYSTEM, user, { temperature: 0.4, timeoutMs: 240_000, numCtx: 8192 });
    const style = (p.style ?? "").toString().trim();
    if (!style) return rules;
    return {
      style: ensureMeta(style, a.bpm, keyScale, a.vocals.present && !opts.voiceBrief ? vocalTags : []),
      caption: (p.caption ?? "").toString().trim(),
      summary: (p.summary ?? "").toString().trim() || rules.summary,
      structure: (p.structure ?? "").toString().trim() || rules.structure,
      bpm: a.bpm,
      keyScale,
      source: "ollama",
    };
  } catch (err) {
    console.warn(`[reference] Ollama no escribió el prompt, se usan las reglas: ${err instanceof Error ? err.message : err}`);
    return rules;
  }
}

/**
 * The measured tempo/key must survive the LLM (it likes to "fix" them), the vocal tags must be there
 * (it drops them one run out of three) and the list is normalised (spacing, duplicates).
 */
function ensureMeta(style: string, bpm: number, keyScale: string | null, vocalTags: string[]): string {
  const tags = dedupe(style.replace(/\b\d{2,3}\s*bpm\b/gi, `${bpm} bpm`).split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean));
  if (!tags.some((t) => /\bbpm\b/i.test(t))) tags.push(`${bpm} bpm`);
  if (keyScale && !tags.some((t) => t.toLowerCase() === keyScale.toLowerCase())) tags.push(keyScale);
  if (vocalTags.length && !tags.some((t) => /\b(vocals?|voice|singer|rap|rapping|singing)\b/i.test(t))) tags.push(...vocalTags.slice(0, 2));
  return tags.join(", ");
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function summarize(a: ReferenceAnalysis, opts: { voiceBrief?: string | null }): string {
  const g = a.tags.genres.slice(0, 2).map((s) => s.label).join(" / ");
  const inst = [...a.tags.instruments.filter((s) => s.group === "melodic").slice(0, 3), ...a.tags.instruments.filter((s) => s.group !== "melodic").filter((s, i, l) => l.findIndex((x) => x.group === s.group) === i)].map((s) => s.label).join(", ");
  const v = a.vocals;
  const gender = v.gender ?? v.pitch?.gender_guess;
  const voice = !v.present ? "instrumental" : `voz ${gender === "male" ? "masculina" : gender === "female" ? "femenina" : "de género ambiguo"}${v.pitch ? ` (${v.pitch.register}, ${v.pitch.low_note}–${v.pitch.high_note})` : ""}${v.language ? ` en ${v.language}` : ""}`;
  const taken = opts.voiceBrief ? "Se toman género, instrumentación, tempo y tonalidad; la voz será la del artista." : "Se toman género, instrumentación, voz, tempo y tonalidad.";
  return `Suena a ${g} con ${inst}; ${voice}; ${a.bpm} bpm en ${a.key}. ${taken}`;
}
