/**
 * Storyboard for a stills video: one Pixar-style scene per lyric section, written by Ollama, laid out on
 * the song's timeline (durations proportional to the section length, cut on bar boundaries).
 */
import type { Artist, Song } from "@/db/schema";
import { chatJson, ollamaAvailable } from "./ollama";
import type { Storyboard, StoryboardScene } from "./video";

const MAX_SCENE_SEC = 26; // longer sections get a second image from a different angle
const MIN_SCENE_SEC = 5;
const MAX_SCENES = 18;

type Section = { name: string; lines: number };

/** Splits lyrics into [Section] blocks with their line counts; an untagged song becomes one section. */
export function lyricSections(lyrics: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const raw of lyrics.split("\n")) {
    const line = raw.trim();
    const tag = line.match(/^\[([^\]]+)\]$/);
    if (tag) {
      cur = { name: tag[1], lines: 0 };
      out.push(cur);
    } else if (line) {
      if (!cur) {
        cur = { name: "Song", lines: 0 };
        out.push(cur);
      }
      cur.lines++;
    }
  }
  return out;
}

const SYSTEM = `Eres director de arte de videoclips. Recibes la canción (título, estilo musical, letra por secciones, artista) y devuelves un storyboard: UNA imagen fija por sección.
Responde SOLO con JSON válido:
{"style": string, "character": string, "scenes": [{"section": string, "prompt": string}]}
- "style": el lenguaje visual del videoclip EN INGLÉS, deducido del género y la personalidad del artista, NO un estilo fijo: puede ser fotografía cinematográfica con grano, ilustración editorial, animación 2D, 3D estilizado, collage, blanco y negro, neón, acuarela… Incluye medio, paleta, luz, época y textura. Una frase; se antepone a todas las escenas.
- "character": descripción visual EN INGLÉS del protagonista (el artista): edad aparente, pelo, ropa, rasgos, actitud. Una frase; se repetirá idéntica en todas las escenas para mantener al personaje.
- "scenes": EXACTAMENTE una por cada entrada de la lista ESCENAS, en ese orden, con ese mismo "section". Ni una más ni una menos. Cuando una sección tiene varias escenas (p. ej. "Verse 1 · 1/2" y "Verse 1 · 2/2") son momentos DISTINTOS de esa sección: cambia la acción, el lugar o el encuadre, nunca el mismo plano desde otro ángulo.
- "prompt": EN INGLÉS, una imagen concreta: dónde está el personaje, qué hace, encuadre (close-up / medium shot; evita planos generales, la cara se pierde), luz, hora, color, emoción. Sin texto ni letras en la imagen. No repitas la descripción del personaje: empieza por la escena.
- Coherencia: mismo mundo y paleta a lo largo de la canción; los estribillos son los momentos más intensos.`;

type Draft = { style?: string; character?: string; scenes?: { section?: string; prompt?: string }[] };

/** Scene prompts via Ollama; a plain fallback when it is off so the feature never blocks. */
async function draftScenes(song: Song, artist: Artist | null, names: string[]): Promise<{ style: string; character: string; prompts: { section: string; prompt: string }[] }> {
  const who = artist ? `${artist.name}. ${artist.description}` : "the singer";
  const fallbackStyle = `Cinematic music video still in the visual language of ${artist?.style || song.style}, high detail, dramatic lighting, no text`;
  const fallbackCharacter = artist?.description ? `The protagonist is ${artist.name}: ${artist.description}` : "The protagonist is the singer of the song";
  if (!(await ollamaAvailable())) {
    return { style: fallbackStyle, character: fallbackCharacter, prompts: names.map((n) => ({ section: n, prompt: sectionFallback(n) })) };
  }
  const user = [
    `Título: ${song.title}`,
    `Estilo: ${song.style}`,
    `Artista: ${who}`,
    `Duración: ${Math.round(song.duration ?? 0)} s`,
    `ESCENAS (${names.length}): ${names.map((n, i) => `${i + 1}. ${n}`).join(" · ")}`,
    song.instrumental ? "Instrumental: sí. Cuenta un viaje visual en 8 escenas." : `Letra:\n${song.lyrics}`,
  ].join("\n");
  let draft = await chatJson<Draft>(SYSTEM, user, { temperature: 0.8, timeoutMs: 300_000 });
  let scenes = Array.isArray(draft.scenes) ? draft.scenes.filter((s) => s?.prompt) : [];
  if (scenes.length < names.length) {
    // Small models often stop early; one stricter retry before falling back per section.
    draft = await chatJson<Draft>(SYSTEM, `${user}\n\nIMPORTANTE: la respuesta anterior tenía ${scenes.length} escenas y hacen falta ${names.length}. Escribe las ${names.length}, cortas (máximo 40 palabras cada una).`, { temperature: 0.6, timeoutMs: 300_000 });
    const retry = Array.isArray(draft.scenes) ? draft.scenes.filter((s) => s?.prompt) : [];
    if (retry.length > scenes.length) scenes = retry;
  }
  const bySection = new Map(scenes.map((s) => [String(s.section ?? "").trim().toLowerCase(), String(s.prompt)]));
  const prompts = names.map((n, i) => ({ section: n, prompt: bySection.get(n.toLowerCase()) ?? (scenes[i]?.prompt ? String(scenes[i].prompt) : sectionFallback(n)) }));
  return { style: String(draft.style ?? "").trim() || fallbackStyle, character: String(draft.character ?? "").trim() || fallbackCharacter, prompts };
}

/** A usable scene when the model skipped a section: the mood follows the section's role in the song. */
function sectionFallback(name: string): string {
  const n = name.toLowerCase();
  const part = n.match(/· (\d+)\/(\d+)$/);
  const later = part && Number(part[1]) > 1 ? ", a later moment of the same section, different action and place" : "";
  const base = sectionFallbackBase(n);
  return base + later;
}

function sectionFallbackBase(n: string): string {
  if (n.includes("intro")) return "Establishing medium shot of the protagonist alone in a quiet space at dawn, soft light, anticipation";
  if (n.includes("chorus")) return "Intense close-up of the protagonist singing with all their heart, dramatic saturated light, motion and energy";
  if (n.includes("bridge")) return "Medium shot of the protagonist at a turning point, looking out at a vast landscape, shifting light between dark and bright";
  if (n.includes("outro")) return "Calm medium shot of the protagonist walking away into warm light, peaceful, resolved";
  return "Intimate close-up of the protagonist lost in thought, cinematic side light, muted colors";
}

/** Scene slots before writing prompts: each section gets 1–3 scenes by length, named "Section · k/n" when split. */
export function planSlots(sections: Section[], total: number, instrumental: boolean): { name: string; duration: number }[] {
  if (instrumental || sections.length === 0) {
    const n = Math.min(MAX_SCENES, Math.max(6, Math.round(total / 22)));
    return Array.from({ length: n }, (_, i) => ({ name: `Scene ${i + 1}`, duration: total / n }));
  }
  const weights = sections.map((s) => Math.max(s.lines, 1.5));
  const sum = weights.reduce((a, b) => a + b, 0);
  const slots: { name: string; duration: number }[] = [];
  for (let i = 0; i < sections.length; i++) {
    const d = (total * weights[i]) / sum;
    const parts = Math.min(Math.ceil(d / MAX_SCENE_SEC), 3);
    for (let k = 0; k < parts; k++) slots.push({ name: parts > 1 ? `${sections[i].name} · ${k + 1}/${parts}` : sections[i].name, duration: d / parts });
  }
  return slots.slice(0, MAX_SCENES);
}

/** Lays the scenes on the timeline: the planned durations, snapped to bars, summing to the song length. */
export function layoutTimeline(prompts: { section: string; prompt: string }[], slots: { name: string; duration: number }[], total: number, bpm: number | null): StoryboardScene[] {
  let scenes: StoryboardScene[] = prompts.map((p, i) => ({ ...p, duration: slots[i]?.duration ?? total / prompts.length }));
  // snap cut points to bars
  const bar = bpm && bpm > 40 && bpm < 300 ? 240 / bpm : 0;
  let t = 0;
  const cuts: number[] = [];
  for (const s of scenes) {
    t += s.duration;
    cuts.push(bar ? Math.round(t / bar) * bar : t);
  }
  let prev = 0;
  scenes = scenes.map((s, i) => {
    const end = i === scenes.length - 1 ? total : Math.max(cuts[i], prev + MIN_SCENE_SEC);
    const d = Math.max(end - prev, MIN_SCENE_SEC);
    prev = prev + d;
    return { ...s, duration: Math.round(d * 100) / 100 };
  });
  // absorb rounding so the sum equals the song length
  const drift = total - scenes.reduce((a, s) => a + s.duration, 0);
  scenes[scenes.length - 1].duration = Math.max(MIN_SCENE_SEC, scenes[scenes.length - 1].duration + drift);
  return scenes;
}

export async function buildStoryboard(song: Song, artist: Artist | null): Promise<Storyboard> {
  const total = song.duration && song.duration > 10 ? song.duration : 180;
  const sections = song.instrumental ? [] : lyricSections(song.lyrics);
  const slots = planSlots(sections, total, song.instrumental);
  const { style, character, prompts } = await draftScenes(song, artist, slots.map((s) => s.name));
  const scenes = layoutTimeline(prompts, slots, total, song.bpm);
  return { style, character, scenes: scenes.map((s) => ({ ...s, section: s.section.replace(/ · \d+\/\d+$/, "") })), total };
}
