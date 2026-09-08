/** Market interpretation and song ideas via the local LLM (Ollama). */
import type { Artist } from "@/db/schema";
import { cacheGet, cacheSet } from "./cache";
import { chatJson } from "./ollama";
import { snapshotForPrompt, type MarketSnapshot } from "./market";

const BASE = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4-coder:latest";
const TTL = 12 * 60 * 60 * 1000;

export type MarketIdea = { title: string; genre: string; style: string; theme: string; hook: string; why: string; fit: "alto" | "medio" | "apuesta" };
export type MarketAnalysis = {
  overview: string;
  trends: { genre: string; signal: "dominante" | "creciendo" | "nicho" | "saturado"; why: string }[];
  gaps: string[];
  ideas: MarketIdea[];
  generatedAt: number;
  model: string;
};

const SYSTEM = `Eres un A&R y analista de mercado musical. Recibes datos reales de listas de éxitos (top 100 con géneros, artistas, fechas de lanzamiento) y, opcionalmente, el perfil de un artista independiente que crea música con IA.
Tu trabajo: interpretar el mercado y proponer qué música crear. Sé concreto y honesto: usa los datos, no inventes cifras. Distingue entre lo que domina (difícil de competir), lo que crece (oportunidad) y los nichos con poco ruido.
Responde SOLO con JSON válido:
{
 "overview": string (4-6 frases en español sobre el estado del mercado),
 "trends": [{"genre": string, "signal": "dominante"|"creciendo"|"nicho"|"saturado", "why": string}] (5-7 items),
 "gaps": [string] (3-5 huecos u oportunidades concretas: cruces de género, temáticas poco explotadas, formatos como duración corta, colaboraciones, idioma),
 "ideas": [{"title": string, "genre": string, "style": string, "theme": string, "hook": string, "why": string, "fit": "alto"|"medio"|"apuesta"}] (6 ideas)
}
Reglas para "ideas":
- "style": tags en inglés separados por coma para un modelo de generación musical (género, mood, instrumentos, tipo de voz, tempo con bpm).
- "theme": de qué trata la canción, en español, 1-2 frases. "hook": una línea de estribillo propuesta en el idioma del artista.
- "why": la razón de mercado en 1 frase, citando el dato (p. ej. "el reggaetón es el 38% del top pero solo el 10% son lanzamientos recientes").
- Si hay perfil de artista: al menos 3 ideas deben respetar su estilo y voz ("fit": "alto"), 2 pueden estirar su estilo hacia lo que crece ("medio") y 1 puede ser una apuesta fuera de su zona ("apuesta"). Si no hay perfil, reparte entre lo dominante, lo que crece y nichos.
- Si hay PERFIL DE VOZ (registro, rango cómodo y timbre medidos): todas las ideas deben poder cantarse en ese rango; los tags de "style" deben indicar ese tipo de voz (p. ej. "male baritone vocals") y nunca otro; prioriza géneros donde ese timbre suena natural y evita los que exigen agudos fuera del rango. Explica en "why" cómo encaja la voz.`;

export async function analyzeMarket(snapshot: MarketSnapshot, artist: Artist | null, refresh = false, voice: string | null = null): Promise<MarketAnalysis> {
  const key = `market-ideas:${snapshot.country}:${snapshot.fetchedAt}:${artist?.id ?? "none"}:${artist ? `${artist.style}|${artist.description}|${artist.vocalLanguage}` : ""}:${voice ?? ""}`;
  if (!refresh) {
    const hit = cacheGet<MarketAnalysis>(key, TTL);
    if (hit) return hit.value;
  }
  const user = [
    "DATOS DE MERCADO:",
    snapshotForPrompt(snapshot),
    "",
    artist
      ? `PERFIL DEL ARTISTA: ${artist.name}. Estilo: ${artist.style || "(sin definir)"}. Descripción: ${artist.description || "(sin descripción)"}. Idioma de la voz: ${artist.vocalLanguage}. ${artist.defaultVoiceId ? "Tiene voz propia grabada." : "No tiene voz propia; usa voz genérica."}`
      : "No hay perfil de artista: propone ideas para cualquier creador.",
    voice ? `PERFIL DE VOZ (medido en su grabación): ${voice}.` : "",
  ].filter(Boolean).join("\n");
  const analysis = await chatJson<MarketAnalysis>(SYSTEM, user, { temperature: 0.5, timeoutMs: 300_000, numCtx: 8192 });
  const out: MarketAnalysis = {
    overview: String(analysis.overview ?? ""),
    trends: Array.isArray(analysis.trends) ? analysis.trends.slice(0, 8) : [],
    gaps: Array.isArray(analysis.gaps) ? analysis.gaps.map(String).slice(0, 6) : [],
    ideas: Array.isArray(analysis.ideas) ? analysis.ideas.slice(0, 8).map((i) => ({ title: String(i.title ?? ""), genre: String(i.genre ?? ""), style: String(i.style ?? ""), theme: String(i.theme ?? ""), hook: String(i.hook ?? ""), why: String(i.why ?? ""), fit: i.fit === "medio" || i.fit === "apuesta" ? i.fit : "alto" })) : [],
    generatedAt: Date.now(),
    model: MODEL,
  };
  cacheSet(key, out);
  return out;
}

const ASK_SYSTEM = `Eres un A&R y analista de mercado musical. Responde en español, con datos concretos del contexto, en un máximo de 8 frases o una lista corta. Si propones canciones, da para cada una: género, tags de estilo en inglés y tema. No inventes cifras que no estén en los datos.`;

export async function askMarket(snapshot: MarketSnapshot, artist: Artist | null, question: string, voice: string | null = null): Promise<string> {
  const user = [
    "DATOS DE MERCADO:",
    snapshotForPrompt(snapshot),
    artist ? `\nPERFIL DEL ARTISTA: ${artist.name}. Estilo: ${artist.style}. Descripción: ${artist.description}. Idioma: ${artist.vocalLanguage}.` : "",
    voice ? `PERFIL DE VOZ (medido): ${voice}. Las propuestas deben caber en ese rango y timbre.` : "",
    `\nPREGUNTA: ${question}`,
  ].join("\n");
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, options: { temperature: 0.5 }, messages: [{ role: "system", content: ASK_SYSTEM }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return (body.message?.content ?? "").trim();
}
