/** Lyric/style writer backed by a local Ollama model (optional). */
import { parseLlmJson } from "./llm-json";
const BASE = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4-coder:latest";

const LANGUAGE_NAMES: Record<string, string> = { es: "español", en: "inglés", pt: "portugués", fr: "francés", it: "italiano", de: "alemán", ja: "japonés", ko: "coreano", zh: "chino" };

export type SongDraft = { title: string; style: string; lyrics: string };

export async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/tags`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const SYSTEM = `Eres un compositor profesional. Escribes canciones para un modelo de generación musical.
Responde SOLO con JSON válido con esta forma exacta:
{"title": string, "style": string, "lyrics": string}
Reglas:
- "style": lista corta de tags en inglés separados por comas (género, mood, instrumentos, voz, tempo). Ej: "indie pop, dreamy, female vocals, synths, 110 bpm".
- "lyrics": letra completa usando etiquetas de estructura en líneas propias: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]. Sin acordes ni comentarios.
- Si se pide instrumental, "lyrics" debe ser exactamente "[Instrumental]".
- La letra va en el idioma pedido. Coros pegajosos, versos concretos, sin clichés vacíos.`;

/** Chat completion that must return a JSON object; tolerant parsing plus one retry at lower temperature. */
export async function chatJson<T>(system: string, user: string, opts: { temperature?: number; timeoutMs?: number; numCtx?: number } = {}): Promise<Partial<T> & Record<string, unknown>> {
  const attempt = async (temperature: number) => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: "json",
        options: { temperature, ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}) },
        messages: [
          { role: "system", content: `${system}\n\nIMPORTANTE: responde con un único objeto JSON válido. Dentro de las cadenas usa \\n para los saltos de línea y escapa las comillas dobles.` },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string }; done_reason?: string };
    const content = body.message?.content ?? "{}";
    try {
      return parseLlmJson<Partial<T> & Record<string, unknown>>(content);
    } catch (err) {
      console.warn(`[ollama] JSON inválido (done_reason=${body.done_reason ?? "?"}, ${content.length} chars):\n${content.slice(0, 1500)}`);
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { raw: content });
    }
  };
  const t = opts.temperature ?? 0.7;
  try {
    return await attempt(t);
  } catch (err) {
    if (err instanceof Error && /respondió/.test(err.message)) throw err;
    try {
      return await attempt(Math.max(0.2, t - 0.4));
    } catch (err2) {
      if (err2 instanceof Error && /respondió/.test(err2.message)) throw err2;
      // Last resort: let the model repair its own output at temperature 0.
      const raw = (err2 as { raw?: string }).raw ?? (err as { raw?: string }).raw ?? "";
      if (!raw.trim()) throw err2;
      return repairJson<T>(raw, opts);
    }
  }
}

/** Asks the model to rewrite a broken response as valid JSON with the same content and shape. */
async function repairJson<T>(raw: string, opts: { timeoutMs?: number; numCtx?: number }): Promise<Partial<T> & Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0, ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}) },
      messages: [
        { role: "system", content: "Recibes la respuesta de otro modelo que debía ser un único objeto JSON pero es inválida. Devuelve SOLO ese objeto como JSON válido, con las mismas claves y el mismo contenido, sin comentarios ni texto fuera del objeto. Usa \\n para los saltos de línea dentro de las cadenas y escapa las comillas dobles internas." },
        { role: "user", content: raw.slice(0, 12_000) },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  });
  if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return parseLlmJson<Partial<T> & Record<string, unknown>>(body.message?.content ?? "{}");
}

export async function draftSong(input: {
  description: string;
  language: string;
  instrumental: boolean;
  /** Summary of the voice that will sing it (see voiceBrief); null = the model's default voice. */
  voice?: string | null;
}): Promise<SongDraft> {
  const voice = input.voice
    ? `\nVoz que cantará: ${input.voice}. Escribe el estilo y la letra para esa voz: elige género, tempo e instrumentación que le favorezcan, no indiques otro tipo de voz, y piensa la melodía dentro de su rango cómodo (frases que no exijan agudos; el estribillo puede subir pero sin pasarse del tope).`
    : "";
  const lang = LANGUAGE_NAMES[input.language] ?? input.language;
  const user = `Descripción: ${input.description}\nIdioma de la letra: ${lang} (${input.language}). TODA la letra debe estar en ${lang}, sin mezclar otros idiomas (nada de catalán, portugués o italiano si el idioma es español).\nInstrumental: ${input.instrumental ? "sí" : "no"}${voice}`;
  const parsed = await chatJson<SongDraft>(SYSTEM, user, { temperature: 0.9 });
  return {
    title: (parsed.title ?? "").trim() || input.description.slice(0, 40),
    style: (parsed.style ?? "").trim(),
    lyrics: input.instrumental ? "[Instrumental]" : cleanLyrics(parsed.lyrics ?? ""),
  };
}

/** Small local models leave escaped newlines, stray markers and odd spacing in the lyrics; ACE-Step would sing them. */
export function cleanLyrics(raw: string): string {
  return raw
    .replace(/\\n/g, "\n") // literal backslash-n sequences the model double-escaped
    .replace(/\\t/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/[_*`]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type EditPlan = {
  op: "cover" | "repaint";
  style: string;
  lyrics: string;
  strength: number; // cover only, 0.3-1.0
  start: number | null; // repaint only, seconds
  end: number | null;
  summary: string;
};

const EDIT_SYSTEM = `Eres un productor musical que traduce instrucciones de edición a operaciones de un modelo de generación musical.
Operaciones disponibles:
- "cover": regenera TODA la canción conservando melodía y estructura, con nuevos tags de estilo. Úsala para cambios de arreglo, instrumentación, género, energía, tempo o timbre ("más batería", "más rock", "quita los sintes", "más lenta"). "strength" = cuánto se conserva del original: 0.9 cambios sutiles, 0.7 cambio de arreglo claro, 0.5 reinterpretación fuerte.
- "repaint": regenera SOLO un tramo (start-end en segundos) y deja el resto igual. Úsala cuando la instrucción se refiere a una parte ("el coro", "el final", "el segundo verso", "el intro") o a cambiar la letra de un fragmento. Si el usuario dio un tramo, respétalo. Si nombra una sección sin tramo, estímalo a partir de la duración.
Responde SOLO con JSON válido:
{"op":"cover"|"repaint","style":string,"lyrics":string,"strength":number,"start":number|null,"end":number|null,"summary":string}
- "style": tags en inglés separados por coma, partiendo del estilo actual y aplicando el cambio pedido. Mantén lo que no se pidió cambiar.
- "lyrics": la letra completa (con las etiquetas [Verse], [Chorus]...). Modifícala solo si la instrucción lo pide; si no, cópiala igual. Para repaint, igualmente devuelve la letra completa.
- "summary": una frase en español explicando qué vas a hacer y por qué esa operación.`;

export async function planEdit(input: { instruction: string; style: string; lyrics: string; duration: number | null; start: number | null; end: number | null }): Promise<EditPlan> {
  return planEditOnce(input);
}

async function planEditOnce(input: { instruction: string; style: string; lyrics: string; duration: number | null; start: number | null; end: number | null }): Promise<EditPlan> {
  const user = [
    `Instrucción del usuario: ${input.instruction}`,
    `Estilo actual: ${input.style || "(sin tags)"}`,
    `Duración: ${input.duration ? `${Math.round(input.duration)} s` : "desconocida"}`,
    input.start !== null || input.end !== null ? `Tramo seleccionado por el usuario: ${input.start ?? 0}s a ${input.end ?? "fin"}s` : "El usuario no marcó un tramo.",
    `Letra actual:\n${input.lyrics || "[Instrumental]"}`,
  ].join("\n");
  const p = await chatJson<EditPlan>(EDIT_SYSTEM, user, { temperature: 0.3 });
  const op: EditPlan["op"] = p.op === "repaint" ? "repaint" : "cover";
  const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
  return {
    op,
    style: (p.style ?? "").toString().trim() || input.style,
    lyrics: (p.lyrics ?? "").toString().trim() || input.lyrics,
    strength: clamp(p.strength, 0.3, 1, 0.75),
    start: op === "repaint" ? clamp(input.start ?? p.start, 0, input.duration ?? 600, 0) : null,
    end: op === "repaint" ? clamp(input.end ?? p.end, 0, input.duration ?? 600, input.duration ?? -1) : null,
    summary: (p.summary ?? "").toString().trim() || (op === "cover" ? "Regenerar la canción con el nuevo arreglo." : "Regenerar el tramo indicado."),
  };
}
