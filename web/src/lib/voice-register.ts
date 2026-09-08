/** Vocal registers (client-safe): labels for the UI and the style tags that steer the music model. */

export const REGISTERS = ["bass", "baritone", "tenor", "alto", "mezzo-soprano", "soprano"] as const;
export type Register = (typeof REGISTERS)[number];

export const REGISTER_LABEL: Record<Register, string> = {
  bass: "Bajo",
  baritone: "Barítono",
  tenor: "Tenor",
  alto: "Contralto",
  "mezzo-soprano": "Mezzosoprano",
  soprano: "Soprano",
};

/**
 * Tags appended to the style prompt when a song will be sung with this voice, so the model writes the
 * melody where the voice actually lives. A speaking-voice reference only covers ~1 octave, and the
 * conversion breaks when the melody sits far above it, so the low registers ask for restrained melodies.
 */
export const REGISTER_TAGS: Record<Register, string> = {
  bass: "male vocal, deep bass voice, low vocal register, melody stays in the low range, no high notes",
  baritone: "male vocal, warm baritone voice, low-mid vocal register, relaxed melody without high belting",
  tenor: "male vocal, tenor voice, mid vocal register, no extreme high notes",
  alto: "female vocal, contralto voice, low female register, melody stays in the low-mid range",
  "mezzo-soprano": "female vocal, mezzo-soprano voice, mid register, no extreme high notes",
  soprano: "female vocal, soprano voice, bright upper register",
};

export type VocalGender = "male" | "female";

/** Gender declared in a style string ("female vocals", "male voice"…), if any. */
export function genderInStyle(style: string): VocalGender | null {
  if (/\b(female|woman|girl)\s+(vocals?|voice|singer)\b/i.test(style)) return "female";
  if (/\b(male|man|boy)\s+(vocals?|voice|singer)\b/i.test(style)) return "male";
  return null;
}

/** Forces the vocal gender in a style: drops contradicting tags and makes sure "<gender> vocals" is present. */
export function applyGender(style: string, gender: VocalGender): string {
  const conflicting = gender === "female" ? /\b(male|man|boy)\s+(vocals?|voice|singer)\b/i : /\b(female|woman|girl)\s+(vocals?|voice|singer)\b/i;
  const tags = style.split(",").map((t) => t.trim()).filter((t) => t && !conflicting.test(t));
  if (!tags.some((t) => genderInStyle(t) === gender)) tags.push(`${gender} vocals`);
  return tags.join(", ");
}

export function isRegister(x: unknown): x is Register {
  return typeof x === "string" && (REGISTERS as readonly string[]).includes(x);
}

export function isMaleRegister(r: Register) {
  return r === "bass" || r === "baritone" || r === "tenor";
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function hzToNote(hz: number) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Rewrites a style prompt for a voice: drops gender tags that contradict its register and appends
 * the voice tags (register, range and timbre; see voicePromptTags). Existing tags are kept.
 */
export function applyRegister(style: string, register: Register, tags: string = voicePromptTags(register, null)): string {
  const male = isMaleRegister(register);
  const conflicting = male ? /\b(female|woman|girl)\s+(vocals?|voice|singer)\b/i : /\b(male|man|boy)\s+(vocals?|voice|singer)\b/i;
  const present = new Set(tags.split(",").map((t) => t.trim().toLowerCase()));
  const cleaned = style
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !conflicting.test(t) && !/^(male|female) vocals?$/i.test(t) && !present.has(t.toLowerCase()))
    .join(", ");
  return [cleaned, tags].filter(Boolean).join(", ");
}

/* ------------------------------------------------------------------------------------------------
 * Voice analysis: descriptors, range tag and genre suggestions.
 * Raw numbers come from the voice service (`POST :8002/analyze`, measured on the speaking
 * reference); everything here is deterministic and explainable so the user can see *why*.
 * ---------------------------------------------------------------------------------------------- */

export type VoiceMetrics = {
  centroid_hz: number; // spectral centroid → brightness
  rolloff_hz: number;
  flatness: number; // spectral flatness → air/noise in the voice
  low_mid_db: number; // energy 80–500 Hz vs 500–3000 Hz → body/weight
  intonation_st: number; // p90 - p10 of the speaking pitch, semitones
  pitch_step_st: number; // median frame-to-frame pitch movement, semitones
  rms_db_std: number; // loudness variation, dB
};

export type VoiceProfile = {
  /** "singing" when the reference itself sings (synthetic singer extracted from a song). */
  kind?: "speech" | "singing";
  median_hz: number;
  p10_hz: number;
  p90_hz: number;
  voiced_ratio: number;
  median_note: string;
  register: string;
  sing_low_hz: number;
  sing_high_hz: number;
  sing_low_note: string;
  sing_high_note: string;
  metrics?: Partial<VoiceMetrics>;
};

export type Trait = "dark" | "warm" | "bright" | "clean" | "airy" | "breathy" | "full" | "medium" | "light" | "flat" | "natural" | "expressive" | "even" | "dynamic" | "smooth" | "jumpy";

export type Descriptor = { trait: Trait; label: string; detail: string };

const T = (trait: Trait, label: string, detail: string): Descriptor => ({ trait, label, detail });

/** Human-readable traits from the raw metrics (thresholds tuned for speech at 16 kHz). */
export function describeVoice(p: VoiceProfile): Descriptor[] {
  const m = p.metrics ?? {};
  const out: Descriptor[] = [];
  const singing = p.kind === "singing";
  if (m.centroid_hz !== undefined) {
    out.push(m.centroid_hz < 950 ? T("dark", "Oscura y aterciopelada", "Poco brillo en los agudos: suena grave y envolvente") : m.centroid_hz < 1500 ? T("warm", "Cálida", "Equilibrio entre cuerpo y brillo") : T("bright", "Brillante", "Mucha presencia en los agudos: corta la mezcla"));
  }
  if (m.flatness !== undefined) {
    out.push(m.flatness < 0.01 ? T("clean", "Limpia", "Casi sin aire: nota definida y estable") : m.flatness < 0.03 ? T("airy", "Con algo de aire", "Un punto de soplo que da intimidad") : T("breathy", "Aireada", "Mucho soplo: íntima, poco potente"));
  }
  if (m.low_mid_db !== undefined) {
    out.push(m.low_mid_db > 12 ? T("full", "Con mucho cuerpo", "Energía grave dominante: pesa y llena") : m.low_mid_db > 4 ? T("medium", "Cuerpo medio", "Ni pesada ni ligera") : T("light", "Ligera", "Poca energía grave: ágil y transparente"));
  }
  if (m.intonation_st !== undefined && !singing) {
    out.push(m.intonation_st < 5 ? T("flat", "Entonación plana", "Habla casi en una nota: ideal para cadencias habladas") : m.intonation_st < 10 ? T("natural", "Entonación natural", "Melodía del habla normal") : T("expressive", "Muy expresiva", "Sube y baja mucho al hablar"));
  }
  if (m.rms_db_std !== undefined) {
    out.push(m.rms_db_std < 4 ? T("even", "Volumen parejo", "Poca variación de intensidad") : T("dynamic", "Dinámica", "Contrastes claros de intensidad"));
  }
  if (m.pitch_step_st !== undefined && !singing) {
    out.push(m.pitch_step_st < 0.5 ? T("smooth", "Ligada", "Los cambios de tono son suaves: canta legato") : T("jumpy", "Quebrada", "Cambios de tono bruscos: fraseo rítmico"));
  }
  return out;
}

/** Short, prompt-friendly tag with the singing range of this voice, e.g. "baritone, vocal range F2–C4". */
export function rangeTag(p: VoiceProfile): string {
  const r = isRegister(p.register) ? p.register : register_for(p.median_hz);
  return `${r}, vocal range ${p.sing_low_note}–${p.sing_high_note}`;
}

function register_for(medianHz: number): Register {
  return medianHz < 98 ? "bass" : medianHz < 125 ? "baritone" : medianHz < 165 ? "tenor" : medianHz < 200 ? "alto" : medianHz < 245 ? "mezzo-soprano" : "soprano";
}

export type GenreSuggestion = { genre: string; brief: string; style: string; score: number; reasons: string[] };

/** `brief`: how the song sounds, in Spanish, to seed the create panel's description (never the reasons: those are about the voice, not the song). */
type Rule = { genre: string; brief: string; style: string; registers: Partial<Record<Register, number>>; traits: Partial<Record<Trait, number>>; why: Partial<Record<Trait, string>> };

/**
 * Each genre scores by register plus the traits that suit it. Points are small integers so the
 * result is a ranking, not a verdict; the `why` texts become the reasons shown to the user.
 */
const GENRES: Rule[] = [
  { genre: "Balada / bolero", brief: "Una balada romántica con aire de bolero: piano suave, cuerdas, tempo lento y mucha emoción", style: "romantic ballad, bolero, soft piano, strings, slow tempo, emotional", registers: { bass: 1, baritone: 3, tenor: 3, alto: 3, "mezzo-soprano": 2, soprano: 1 }, traits: { warm: 2, dark: 2, full: 1, smooth: 2, dynamic: 1 }, why: { warm: "el timbre cálido abraza la melodía", dark: "el color oscuro da intimidad", smooth: "el fraseo ligado luce en frases largas", dynamic: "los contrastes de intensidad venden la emoción" } },
  { genre: "Folk acústico / cantautor", brief: "Una canción de cantautor, folk acústico íntimo y cálido, con guitarra acústica al frente", style: "acoustic folk, singer-songwriter, acoustic guitar, intimate, warm", registers: { bass: 2, baritone: 3, tenor: 2, alto: 3, "mezzo-soprano": 2, soprano: 1 }, traits: { warm: 2, dark: 1, airy: 2, breathy: 1, natural: 1, light: 1 }, why: { warm: "cálida y cercana, como una guitarra de madera", airy: "el aire suena honesto y de cerca", natural: "la entonación natural encaja con un fraseo hablado-cantado" } },
  { genre: "Trova / nueva canción", brief: "Una trova al estilo de la nueva canción latinoamericana: guitarra de nylon, letra poética, íntima", style: "trova, nueva canción latinoamericana, nylon guitar, poetic, intimate", registers: { bass: 2, baritone: 3, tenor: 2, alto: 2, "mezzo-soprano": 1 }, traits: { dark: 2, warm: 1, clean: 1, flat: 1, natural: 1 }, why: { dark: "la voz grave sostiene el texto sin adornos", clean: "la nota limpia deja oír la letra", flat: "una entonación contenida favorece el relato" } },
  { genre: "Bossa nova / jazz vocal", brief: "Una bossa nova con toque de jazz vocal: guitarra de nylon, escobillas, suave y nocturna", style: "bossa nova, jazz vocal, nylon guitar, brushed drums, smooth, late night", registers: { bass: 2, baritone: 3, tenor: 1, alto: 3, "mezzo-soprano": 2 }, traits: { dark: 2, airy: 2, breathy: 2, light: 1, smooth: 2, even: 1 }, why: { dark: "el color oscuro es el sonido clásico del género", airy: "el soplo susurrado es marca de la bossa", smooth: "todo ligado, sin ataques duros", even: "el volumen parejo mantiene la calma" } },
  { genre: "Soul / R&B", brief: "Un soul con groove de R&B: piano eléctrico, bajo suave, emocional y expresivo", style: "soul, r&b, groove, electric piano, smooth bass, emotional, expressive vocals", registers: { baritone: 2, tenor: 3, alto: 3, "mezzo-soprano": 3, soprano: 1 }, traits: { full: 2, warm: 1, expressive: 2, dynamic: 2, smooth: 1 }, why: { full: "el cuerpo grave da el peso que pide el groove", expressive: "la entonación amplia se traduce en melismas", dynamic: "los contrastes dan la intención del soul" } },
  { genre: "Blues", brief: "Un blues lento y crudo: guitarra eléctrica, órgano Hammond, con alma", style: "blues, slow blues, electric guitar, hammond organ, raw, soulful", registers: { bass: 3, baritone: 3, tenor: 2, alto: 2, "mezzo-soprano": 1 }, traits: { dark: 2, full: 2, dynamic: 1, jumpy: 1 }, why: { dark: "grave y con sombra, como pide el blues", full: "el cuerpo hace creíble el lamento", jumpy: "el fraseo quebrado funciona en los bends" } },
  { genre: "Rock clásico", brief: "Un rock clásico con guitarras eléctricas, batería con empuje y estribillo coreable", style: "classic rock, electric guitars, driving drums, anthemic chorus", registers: { baritone: 2, tenor: 3, alto: 2, "mezzo-soprano": 2, soprano: 1 }, traits: { full: 2, bright: 2, dynamic: 2, clean: 1 }, why: { full: "el cuerpo aguanta guitarras y batería", bright: "el brillo atraviesa la distorsión", dynamic: "los contrastes llevan del verso al estribillo" } },
  { genre: "Indie / dream pop", brief: "Un indie dream pop: guitarras con reverb, pads de sintetizador, atmósfera suave y brumosa", style: "indie pop, dream pop, reverb guitars, synth pads, mellow, hazy", registers: { baritone: 2, tenor: 2, alto: 3, "mezzo-soprano": 2, soprano: 2 }, traits: { airy: 2, breathy: 2, light: 2, even: 1, smooth: 1, dark: 1 }, why: { airy: "el aire se funde con el reverb", light: "una voz ligera flota sobre los sintes", even: "sin picos de volumen: atmósfera constante" } },
  { genre: "Lo-fi / bedroom pop", brief: "Un lo-fi bedroom pop: batería suave, calidez de cinta, relajado y contenido", style: "lo-fi, bedroom pop, soft drums, warm tape, chill, understated vocals", registers: { bass: 2, baritone: 3, tenor: 2, alto: 3, "mezzo-soprano": 2 }, traits: { airy: 2, breathy: 2, flat: 2, even: 2, dark: 1, light: 1 }, why: { airy: "el susurro es el sonido del género", flat: "la entonación contenida suena relajada", even: "sin dinámica exagerada: todo en calma" } },
  { genre: "Pop", brief: "Un pop pegajoso con producción pulida, sintetizadores brillantes y ritmo animado", style: "pop, catchy chorus, polished production, bright synths, upbeat", registers: { tenor: 3, alto: 1, "mezzo-soprano": 3, soprano: 3, baritone: 1 }, traits: { bright: 3, light: 1, clean: 1, natural: 1, dynamic: 1 }, why: { bright: "el brillo destaca en una producción pulida", clean: "la nota limpia afina bien en estribillos", dynamic: "contrastes que levantan el estribillo" } },
  { genre: "Rap / hip hop", brief: "Un hip hop con batería boom bap, bajo profundo y flow hablado", style: "hip hop, rap, boom bap drums, deep bass, spoken flow", registers: { bass: 3, baritone: 3, tenor: 2, alto: 2, "mezzo-soprano": 1 }, traits: { flat: 3, clean: 2, full: 1, dark: 1, even: 1, jumpy: 1 }, why: { flat: "habla casi en una nota: el flow sale natural", clean: "dicción clara, cada sílaba se entiende", full: "la voz grave llena el beat", jumpy: "el fraseo quebrado marca el ritmo" } },
  { genre: "Urbano / reggaetón", brief: "Un reggaetón urbano con dembow, bajo 808, rap melódico y estribillo pegajoso", style: "reggaeton, latin urban, dembow beat, 808 bass, melodic rap, catchy hook", registers: { bass: 1, baritone: 3, tenor: 3, alto: 2, "mezzo-soprano": 2 }, traits: { flat: 2, clean: 1, full: 1, even: 1, natural: 1 }, why: { flat: "cadencia hablada-cantada, que es la base del género", full: "grave y con cuerpo sobre el dembow", even: "intensidad constante para el flow" } },
  { genre: "Bachata", brief: "Una bachata romántica y sensual con requinto, bongó y güira", style: "bachata, requinto guitar, bongo, güira, romantic, sensual", registers: { baritone: 1, tenor: 3, alto: 1, "mezzo-soprano": 2, soprano: 1 }, traits: { bright: 2, expressive: 2, dynamic: 1, smooth: 1 }, why: { bright: "brillo en los agudos, como los cantantes del género", expressive: "la entonación amplia da el dramatismo" } },
  { genre: "Salsa", brief: "Una salsa enérgica con sección de metales, piano montuno, congas y timbales", style: "salsa, brass section, piano montuno, congas, timbales, energetic", registers: { baritone: 1, tenor: 3, "mezzo-soprano": 2, soprano: 1 }, traits: { bright: 2, full: 2, dynamic: 2, clean: 1 }, why: { bright: "hace falta brillo para pasar sobre los metales", full: "cuerpo para sostener la sección rítmica", dynamic: "energía y contrastes en el montuno" } },
  { genre: "Ranchera / regional", brief: "Una ranchera con mariachi: trompetas, vihuela, apasionada y dramática", style: "ranchera, mariachi, trumpets, vihuela, passionate, dramatic", registers: { baritone: 3, tenor: 3, "mezzo-soprano": 2, alto: 1 }, traits: { full: 3, dynamic: 2, expressive: 1, clean: 1 }, why: { full: "voz de pecho con cuerpo, esencial en la ranchera", dynamic: "gritos y contrastes dramáticos", expressive: "la entonación amplia da el sentimiento" } },
  { genre: "Cumbia", brief: "Una cumbia festiva y bailable con acordeón, güiro y bajo", style: "cumbia, accordion, güiro, bass, festive, danceable", registers: { baritone: 3, tenor: 3, alto: 2, "mezzo-soprano": 2 }, traits: { natural: 2, even: 1, clean: 1, warm: 1, bright: 1 }, why: { natural: "melodías sencillas que no exigen extremos", even: "intensidad pareja para bailar sin parar", warm: "timbre amable y festivo" } },
  { genre: "Country / americana", brief: "Una canción country americana: guitarra acústica y slide, cálida, que cuenta una historia", style: "country, americana, acoustic and slide guitar, warm, storytelling", registers: { bass: 2, baritone: 3, tenor: 2, alto: 2, "mezzo-soprano": 1 }, traits: { warm: 2, clean: 1, natural: 2, dark: 1 }, why: { warm: "el timbre cálido cuenta historias", natural: "fraseo hablado-cantado, propio del género", clean: "la dicción clara sirve al relato" } },
  { genre: "Gospel", brief: "Un gospel con coro, órgano Hammond y palmas, elevado y con voz poderosa", style: "gospel, choir, hammond organ, handclaps, uplifting, powerful vocals", registers: { tenor: 2, alto: 2, "mezzo-soprano": 3, soprano: 2, baritone: 1 }, traits: { full: 2, dynamic: 3, expressive: 2, bright: 1 }, why: { full: "voz con cuerpo para liderar un coro", dynamic: "grandes contrastes: de susurro a grito", expressive: "la entonación amplia se vuelve melisma" } },
];

/** Ranks the genres for this voice. `reasons` explains the traits that matched; `style` is a ready prompt. */
export function suggestGenres(p: VoiceProfile, limit = 6): { best: GenreSuggestion[]; worst: GenreSuggestion[] } {
  const register = isRegister(p.register) ? p.register : register_for(p.median_hz);
  const traits = new Set(describeVoice(p).map((d) => d.trait));
  const scored = GENRES.map((g) => {
    const reasons: string[] = [];
    let score = g.registers[register] ?? 0;
    for (const [trait, pts] of Object.entries(g.traits) as [Trait, number][]) {
      if (!traits.has(trait)) continue;
      score += pts;
      const why = g.why[trait];
      if (why) reasons.push(why);
    }
    if ((g.registers[register] ?? 0) >= 3) reasons.unshift(`registro de ${REGISTER_LABEL[register].toLowerCase()} muy habitual en el género`);
    return { genre: g.genre, brief: g.brief, style: g.style, score, reasons: reasons.slice(0, 3) };
  }).sort((a, b) => b.score - a.score);
  return { best: scored.slice(0, limit), worst: scored.slice(-2).reverse() };
}

/** Parses the JSON profile stored on a voice row; the user's register override wins over the measured one. */
export function parseVoiceProfile(v: { profile: string | null; register: string | null }): VoiceProfile | null {
  if (!v.profile) return null;
  try {
    const p = JSON.parse(v.profile) as VoiceProfile;
    return { ...p, register: isRegister(v.register) ? v.register : p.register };
  } catch {
    return null;
  }
}

/** Timbre traits → tags for the music model, so the generated vocal is already close to the voice it will become. */
const TRAIT_TAGS: Partial<Record<Trait, string>> = {
  dark: "dark warm vocal timbre",
  warm: "warm vocal timbre",
  bright: "bright vocal timbre",
  clean: "clean vocals",
  airy: "soft breathy vocals",
  breathy: "breathy intimate vocals",
  full: "full-bodied deep voice",
  light: "light airy voice",
  smooth: "legato phrasing",
  jumpy: "rhythmic phrasing",
  flat: "narrow melodic range, spoken-sung delivery",
  expressive: "expressive melody",
};

/**
 * Everything the music model is told about a voice: register tags, the singing range and up to
 * four timbre tags. This is what gets appended to the style of every song sung with that voice.
 */
/** For a sung reference the melody need not be held back: the voice already covers its measured range. */
const SINGING_REGISTER_TAGS: Record<Register, string> = {
  bass: "male vocal, deep bass voice",
  baritone: "male vocal, warm baritone voice",
  tenor: "male vocal, tenor voice",
  alto: "female vocal, contralto voice",
  "mezzo-soprano": "female vocal, mezzo-soprano voice",
  soprano: "female vocal, soprano voice",
};

export function voicePromptTags(register: Register, profile: VoiceProfile | null): string {
  const parts = [profile?.kind === "singing" ? SINGING_REGISTER_TAGS[register] : REGISTER_TAGS[register]];
  if (profile) {
    parts.push(`vocal range ${profile.sing_low_note}–${profile.sing_high_note}`);
    const traits = describeVoice(profile).map((d) => TRAIT_TAGS[d.trait]).filter((t): t is string => !!t);
    parts.push(...traits.slice(0, 4));
  }
  return parts.join(", ");
}

/** Short Spanish summary of what a voice can do, for the LLM that drafts lyrics/style. */
export function voiceBrief(register: Register, profile: VoiceProfile | null): string {
  const bits = [`registro ${REGISTER_LABEL[register].toLowerCase()} (${register})`];
  if (profile) {
    bits.push(profile.kind === "singing" ? `voz cantada, rango medido ${profile.sing_low_note}–${profile.sing_high_note}` : `rango cómodo de canto ${profile.sing_low_note}–${profile.sing_high_note} (habla en ${profile.median_note})`);
    const traits = describeVoice(profile).map((d) => d.label.toLowerCase());
    if (traits.length) bits.push(`timbre: ${traits.join(", ")}`);
  }
  return bits.join("; ");
}
