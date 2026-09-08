"use client";

import { useEffect, useState } from "react";
import { isRegister, parseVoiceProfile, REGISTER_LABEL, voicePromptTags } from "@/lib/voice-register";
import { KNOWN_MODELS, LANGUAGES, type AlbumDTO, type ArtistDTO, type CreateDraft, type EngineStatus, type SongDTO, type VoiceDTO } from "@/lib/types";

type Mode = "simple" | "custom";

const STYLE_IDEAS = ["reggaeton, latin trap, 808s, male vocals", "indie folk, acoustic guitar, warm, female vocals", "synthwave, retro, 80s, driving", "boom bap hip hop, jazzy samples, rap", "bachata, romantic, guitars", "lo-fi hip hop, chill, instrumental", "rock alternativo, guitarras distorsionadas, energético", "bolero, orquestal, nostálgico"];

export default function CreatePanel({ status, voices, artist, albums, draft, onCreated, onError, onGoToVoices, onClearDraft }: { status: EngineStatus | null; voices: VoiceDTO[]; artist: ArtistDTO | null; albums: AlbumDTO[]; draft: CreateDraft | null; onCreated: (s: SongDTO[]) => void; onError: (e: string | null) => void; onGoToVoices: () => void; onClearDraft?: () => void }) {
  const [mode, setMode] = useState<Mode>("simple");
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [language, setLanguage] = useState("es");
  const [duration, setDuration] = useState<number>(120);
  const [autoDuration, setAutoDuration] = useState(true);
  const [model, setModel] = useState<string>("");
  const [useVoice, setUseVoice] = useState(false);
  const [autotune, setAutotune] = useState(false);
  const [voiceId, setVoiceId] = useState<string>("");
  const [albumId, setAlbumId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [writing, setWriting] = useState(false);
  const selectedVoice = voices.find((v) => v.id === voiceId) ?? voices.find((v) => v.id === artist?.defaultVoiceId) ?? voices[0];
  const engineOnline = !!status?.engine.online;

  // Artist defaults first, then the draft (e.g. a market idea) on top, in one pass so nothing overwrites it.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setStyle(draft?.style ?? artist?.style ?? "");
      setLanguage(artist?.vocalLanguage ?? "es");
      setUseVoice(!!artist?.defaultVoiceId);
      setVoiceId(artist?.defaultVoiceId ?? "");
      setAlbumId("");
      if (draft) {
        setMode(draft.mode ?? "simple");
        setTitle(draft.title ?? "");
        setDescription(draft.description ?? "");
        setLyrics("");
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [artist?.id, artist?.style, artist?.vocalLanguage, artist?.defaultVoiceId, draft]);

  const writeLyrics = async () => {
    if (!description.trim()) return onError("Escribe una descripción para generar la letra.");
    setWriting(true);
    onError(null);
    try {
      const fullDescription = artist?.description ? `${description}\n\nSobre el artista (${artist.name}): ${artist.description}${style ? `\nEstilo habitual: ${style}` : ""}` : description;
      const res = await fetch("/api/lyrics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: fullDescription, language, instrumental, voiceId: useVoice && selectedVoice ? selectedVoice.id : null }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo escribir la letra");
      setTitle(body.draft.title ?? "");
      setStyle(body.draft.style ?? "");
      setLyrics(body.draft.lyrics ?? "");
      setMode("custom");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          title: title || undefined,
          description: mode === "simple" && artist ? [description, artist.description ? `Sobre el artista (${artist.name}): ${artist.description}` : "", artist.style ? `Estilo habitual: ${artist.style}` : ""].filter(Boolean).join("\n\n") : description || undefined,
          style: style || undefined,
          lyrics: lyrics || undefined,
          instrumental,
          duration: autoDuration ? null : duration,
          vocalLanguage: language,
          model: model || null,
          voiceId: useVoice && !instrumental && selectedVoice ? selectedVoice.id : null,
          autotune: useVoice && !instrumental && !!selectedVoice && autotune,
          artistId: artist?.id ?? null,
          albumId: artist && albumId ? albumId : null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error al crear la canción");
      onCreated(body.songs as SongDTO[]);
      onClearDraft?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = engineOnline && !submitting && (mode === "simple" ? description.trim().length > 0 : style.trim().length > 0 && (instrumental || lyrics.trim().length > 0));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex rounded-lg bg-panel p-1 border border-border">
        {(["simple", "custom"] as Mode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${mode === m ? "bg-panel-2 text-fg shadow" : "text-muted hover:text-fg"}`}>
            {m === "simple" ? "Simple" : "Personalizado"}
          </button>
        ))}
      </div>

      {draft && (
        <div className="rounded-lg border border-accent-2/50 bg-accent-2/10 px-3 py-2 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-fg">💡 {draft.label ?? "Idea de mercado cargada"}{draft.title ? `: ${draft.title}` : ""}</p>
              {draft.style && <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={draft.style}>{draft.style}</p>}
            </div>
            <button type="button" onClick={() => { onClearDraft?.(); setTitle(""); setDescription(""); setStyle(artist?.style ?? ""); }} className="shrink-0 text-muted hover:text-fg" title="Quitar la idea">✕</button>
          </div>
          <p className="mt-1 text-muted">{draft.title ? "Se usarán este título y estilo. Edita la descripción si quieres" : "Se usará este estilo. Completa de qué trata la canción"} y pulsa «Crear canción».</p>
        </div>
      )}

      {mode === "simple" ? (
        <Field label="Describe tu canción" hint="Tema, género, mood, instrumentos, tipo de voz…">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="Una balada pop en español sobre reencontrarse con un amigo de la infancia, piano y cuerdas, voz femenina íntima" className={inputCls} />
        </Field>
      ) : (
        <>
          <Field label="Título">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Opcional" className={inputCls} />
          </Field>
          <Field label="Estilo" hint="Tags separados por coma, en inglés funciona mejor">
            <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2} placeholder="latin pop, upbeat, female vocals, 100 bpm" className={inputCls} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STYLE_IDEAS.map((s) => (
                <button key={s} type="button" onClick={() => setStyle(s)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:text-fg hover:border-accent-2">
                  {s.split(",")[0]}
                </button>
              ))}
            </div>
          </Field>
          {!instrumental && (
            <Field label="Letra" hint="Usa [Verse], [Chorus], [Bridge]… para marcar la estructura">
              <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} rows={12} placeholder={"[Verse 1]\n...\n\n[Chorus]\n..."} className={`${inputCls} font-mono text-[13px]`} />
              <div className="mt-2 flex items-center gap-2">
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe la canción y deja que la IA escriba la letra" className={`${inputCls} text-xs`} />
                <button type="button" onClick={writeLyrics} disabled={writing} className="shrink-0 rounded-md border border-accent-2/50 px-3 py-2 text-xs text-fg hover:bg-accent-2/20 disabled:opacity-50">
                  {writing ? "Escribiendo…" : "✨ Escribir letra"}
                </button>
              </div>
            </Field>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Idioma de la voz">
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Modelo" hint={KNOWN_MODELS.find((m) => m.name === (model || status?.engine.defaultModel))?.hint}>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
            <option value="">Cargado ahora{status?.engine.defaultModel ? ` · ${KNOWN_MODELS.find((m) => m.name === status.engine.defaultModel)?.label ?? status.engine.defaultModel}` : ""}</option>
            {[...KNOWN_MODELS, ...(status?.engine.models ?? []).filter((m) => !KNOWN_MODELS.some((k) => k.name === m.name)).map((m) => ({ name: m.name, label: m.name, hint: "" }))]
              .filter((m) => m.name !== status?.engine.defaultModel)
              .map((m) => (
                <option key={m.name} value={m.name}>{m.label}</option>
              ))}
          </select>
        </Field>
      </div>

      <label className="flex items-center justify-between rounded-lg border border-border bg-panel px-3 py-2.5 text-sm">
        <span>Instrumental (sin voz)</span>
        <Toggle checked={instrumental} onChange={setInstrumental} />
      </label>

      {!instrumental && (
        <div className="rounded-lg border border-border bg-panel px-3 py-2.5 text-sm">
          <label className="flex items-center justify-between">
            <span>🎤 {artist ? `Cantar con la voz de ${artist.name}` : "Cantar con mi voz"}</span>
            <Toggle checked={useVoice} onChange={setUseVoice} />
          </label>
          {useVoice && (
            voices.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                {artist ? `${artist.name} no tiene voz grabada.` : "No tienes ninguna voz guardada."} <button type="button" onClick={onGoToVoices} className="text-accent-2 underline">Graba una</button> (10–30 s hablando).
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                <select value={selectedVoice?.id ?? ""} onChange={(e) => setVoiceId(e.target.value)} className={inputCls}>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted">
                  {status?.voice.online ? "La canción se genera y después se convierte a tu timbre (1–3 min extra)." : "El servicio de voz está apagado: ejecuta make voice."}
                  {isRegister(selectedVoice?.register) && ` La música se escribe en registro de ${REGISTER_LABEL[selectedVoice.register].toLowerCase()} para que la voz no se fuerce en los agudos.`}
                </p>
                {selectedVoice && isRegister(selectedVoice.register) && (
                  <p className="rounded-md bg-panel-2/60 px-2 py-1 font-mono text-[10px] leading-relaxed text-muted" title="Tags que se añaden al estilo para que el modelo componga en el rango de esta voz">
                    <span className="font-sans">Se añade al estilo:</span> {voicePromptTags(selectedVoice.register, parseVoiceProfile(selectedVoice))}
                  </p>
                )}
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span>
                    <span className="block">Afinar la voz (autotune)</span>
                    <span className="block text-[11px] text-muted">Corrige la entonación a la escala de la canción al convertir. Se puede cambiar después por canción.</span>
                  </span>
                  <Toggle checked={autotune} onChange={setAutotune} />
                </label>
              </div>
            )
          )}
        </div>
      )}

      {artist && (
        <Field label={`Álbum de ${artist.name}`} hint="opcional">
          <select value={albumId} onChange={(e) => setAlbumId(e.target.value)} className={inputCls}>
            <option value="">Sin álbum</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label={`Duración · ${autoDuration ? "automática" : `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, "0")}`}`}>
        <div className="flex items-center gap-3">
          <input type="range" min={10} max={300} step={5} value={duration} disabled={autoDuration} onChange={(e) => setDuration(Number(e.target.value))} className="flex-1 accent-[var(--accent)] disabled:opacity-40" />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={autoDuration} onChange={(e) => setAutoDuration(e.target.checked)} className="accent-[var(--accent)]" /> auto
          </label>
        </div>
      </Field>

      <button onClick={submit} disabled={!canSubmit} className="rounded-xl py-3 font-semibold text-white shadow-lg transition disabled:opacity-40" style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }}>
        {submitting ? "Enviando al motor…" : engineOnline ? "Crear canción" : "Motor apagado · ejecuta make engine"}
      </button>
      <p className="text-[11px] text-muted leading-relaxed">
        Cada creación produce 2 variantes. En un Mac la generación tarda ~30 s por minuto de audio. Modo simple escribe la letra con {status?.ollama.online ? `Ollama (${status.ollama.model})` : "el LM de ACE-Step"}.
      </p>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent-2";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {hint && <span className="text-[11px] text-muted/70">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-accent" : "bg-border"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? "left-5.5" : "left-0.5"}`} style={{ left: checked ? 22 : 2 }} />
    </button>
  );
}
