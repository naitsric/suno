"use client";

import { useEffect, useRef, useState } from "react";
import type { ArtistDTO, VoiceDTO } from "@/lib/types";
import { describeVoice, hzToNote, isRegister, rangeTag, REGISTER_LABEL, REGISTERS, suggestGenres, type Register, type VoiceProfile } from "@/lib/voice-register";

const MIN_SEC = 10;
const MAX_SEC = 30;
const SCRIPT = "Hola, esta es mi voz. Me gusta la música que suena por la mañana, el café recién hecho y los domingos sin prisa. Esta grabación sirve para que las canciones suenen con mi timbre.";

function parseProfile(v: VoiceDTO): VoiceProfile | null {
  if (!v.profile) return null;
  try {
    const p = JSON.parse(v.profile) as VoiceProfile;
    return { ...p, register: isRegister(v.register) ? v.register : p.register };
  } catch {
    return null;
  }
}

/** Range tag, timbre descriptors and genre suggestions for one voice, with one-click song creation. */
function VoiceAnalysis({ voice, onUseStyle, onError, onChange }: { voice: VoiceDTO; onUseStyle?: (style: string, genre: string, brief: string) => void; onError: (e: string | null) => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const profile = parseProfile(voice);

  const reanalyze = async () => {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/voices/${voice.id}/analyze`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo analizar");
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!profile) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
        <span>Sin análisis todavía.</span>
        <button type="button" onClick={reanalyze} disabled={busy} className="rounded-md border border-border px-2 py-0.5 hover:text-fg disabled:opacity-50">{busy ? "Analizando…" : "Analizar voz"}</button>
      </div>
    );
  }

  const tag = rangeTag(profile);
  const traits = describeVoice(profile);
  const { best, worst } = suggestGenres(profile, 5);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tag);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onError("No se pudo copiar");
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg bg-panel-2/60 p-2.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">Tag de rango:</span>
        <code className="rounded-md bg-panel px-1.5 py-0.5 font-mono text-[11px] text-fg">{tag}</code>
        <button type="button" onClick={copy} className="rounded-md border border-border px-1.5 py-0.5 text-muted hover:text-fg" title="Copiar para pegarlo en un estilo">{copied ? "Copiado" : "Copiar"}</button>
      </div>
      {traits.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {traits.map((t) => (
            <span key={t.trait} title={t.detail} className="rounded-full border border-border bg-panel px-2 py-0.5 text-fg/90">{t.label}</span>
          ))}
        </div>
      )}
      <div>
        <p className="mb-1 font-medium text-fg">Le va bien</p>
        <ul className="flex flex-col gap-1">
          {best.map((g) => (
            <li key={g.genre} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <span className="text-fg">{g.genre}</span>
                {g.reasons.length > 0 && <span className="text-muted"> · {g.reasons.join("; ")}</span>}
              </div>
              {onUseStyle && (
                <button type="button" onClick={() => onUseStyle(g.style, g.genre, g.brief)} className="shrink-0 rounded-md border border-accent-2/60 px-1.5 py-0.5 text-accent-2 hover:bg-accent-2/10" title={g.style}>Crear</button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-muted">Menos natural: {worst.map((g) => g.genre).join(", ")}.</p>
      </div>
      <div className="flex items-center gap-2 text-muted">
        <button type="button" onClick={reanalyze} disabled={busy} className="shrink-0 whitespace-nowrap rounded-md border border-border px-2 py-0.5 hover:text-fg disabled:opacity-50">{busy ? "Analizando…" : "Volver a analizar"}</button>
        <span>{profile.kind === "singing" ? "Medido sobre la voz cantada; el registro se puede corregir arriba." : "Medido sobre la grabación hablada; cambia el registro arriba si no coincide con cómo cantas."}</span>
      </div>
    </div>
  );
}

export default function VoicePanel({ voices, artistId = null, artists = [], compact = false, onChange, onError, onUseStyle }: { voices: VoiceDTO[]; artistId?: string | null; artists?: ArtistDTO[]; compact?: boolean; onChange: () => void; onError: (e: string | null) => void; onUseStyle?: (style: string, genre: string, brief: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState("Mi voz");
  const [saving, setSaving] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  // Object URL for the recorded preview; revoked whenever the blob changes or the panel unmounts.
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const id = window.setTimeout(() => setPreviewUrl(url), 0);
    return () => {
      window.clearTimeout(id);
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [blob]);

  const stop = () => {
    recRef.current?.stop();
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    if (timerRef.current) window.clearInterval(timerRef.current);
    setRecording(false);
  };

  const start = async () => {
    onError(null);
    try {
      // Raw capture: the browser's echo cancellation / noise suppression / AGC smear the timbre the
      // conversion model has to learn (hollow, "underwater" voice). Cleanup happens server-side instead.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 } });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => setBlob(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
      rec.start(250);
      recRef.current = rec;
      setBlob(null);
      setSeconds(0);
      setRecording(true);
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(s);
        if (s >= MAX_SEC) stop();
      }, 250);
    } catch {
      onError("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
    }
  };

  const upload = async (file: Blob, filename: string) => {
    setSaving(true);
    onError(null);
    try {
      const form = new FormData();
      form.append("audio", file, filename);
      form.append("name", name);
      if (artistId) form.append("artistId", artistId);
      const res = await fetch("/api/voices", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo guardar la voz");
      setBlob(null);
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/voices/${id}`, { method: "DELETE" });
    onChange();
  };

  const assign = async (id: string, target: string) => {
    const res = await fetch(`/api/voices/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ artistId: target || null }) });
    if (!res.ok) return onError("No se pudo asignar la voz");
    onChange();
  };

  const [cleaning, setCleaning] = useState<string | null>(null);
  const clean = async (id: string) => {
    setCleaning(id);
    onError(null);
    try {
      const res = await fetch(`/api/voices/${id}/clean`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo retocar la voz");
      onChange();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(null);
    }
  };

  const setUseClean = async (id: string, useClean: boolean) => {
    const res = await fetch(`/api/voices/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ useClean }) });
    if (!res.ok) return onError("No se pudo cambiar la versión de la voz");
    onChange();
  };

  const setRegister = async (id: string, register: Register) => {
    const res = await fetch(`/api/voices/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ register }) });
    if (!res.ok) return onError("No se pudo cambiar el registro");
    onChange();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-panel p-4">
        <p className="text-sm font-medium">{compact ? "Grabar una voz hablando" : "Graba tu voz hablando"}</p>
        <p className="mt-1 text-xs text-muted">No hace falta cantar. {compact ? "La persona lee" : "Lee"} este texto con voz normal durante {MIN_SEC}–{MAX_SEC} s en un sitio silencioso:</p>
        <p className="mt-1 text-[11px] text-muted" title="El micrófono se captura en crudo; la limpieza (ruido, sala, EQ) se hace después con «Retocar grabación»">🎙️ Mejor cuanto más cerca del micrófono (10–20 cm), en un cuarto pequeño con cortinas, cama o ropa; evita cocinas y pasillos. Graba los {MAX_SEC} s completos.</p>
        <blockquote className="mt-2 rounded-lg bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-fg/90">{SCRIPT}</blockquote>

        <div className="mt-3 flex items-center gap-3">
          {!recording ? (
            <button onClick={start} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">
              <span className="h-2.5 w-2.5 rounded-full bg-white" /> Grabar
            </button>
          ) : (
            <button onClick={stop} className="flex items-center gap-2 rounded-lg border border-accent px-3 py-2 text-sm font-medium text-accent">
              <span className="pulse h-2.5 w-2.5 rounded-sm bg-accent" /> Detener · {seconds}s
            </button>
          )}
          <label className="cursor-pointer rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg">
            Subir archivo
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f, f.name); e.target.value = ""; }} />
          </label>
        </div>

        {recording && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-panel-2">
            <div className="h-full bg-accent transition-all" style={{ width: `${(seconds / MAX_SEC) * 100}%` }} />
          </div>
        )}

        {blob && previewUrl && (
          <div className="mt-3 flex flex-col gap-2">
            <audio controls src={previewUrl} className="w-full" />
            {seconds < MIN_SEC && <p className="text-xs text-amber-300">Solo {seconds}s. Con al menos {MIN_SEC}s el parecido mejora mucho.</p>}
            <div className="flex items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent-2" placeholder="Nombre" />
              <button onClick={() => upload(blob, `grabacion.${blob.type.includes("mp4") ? "m4a" : "webm"}`)} disabled={saving} className="rounded-lg bg-accent-2 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {saving ? "Guardando…" : "Guardar voz"}
              </button>
              <button onClick={() => setBlob(null)} className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-fg">Descartar</button>
            </div>
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Voces guardadas · {voices.length}</p>
        {voices.length === 0 ? (
          <p className="text-xs text-muted">{compact ? "Este artista no tiene voz. Sin voz, sus canciones usan la voz genérica del modelo." : "Todavía no tienes ninguna. Graba una arriba y luego activa «Cantar con mi voz» al crear."}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {voices.map((v) => (
              <li key={v.id} className="rounded-lg border border-border bg-panel px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{v.kind === "singing" ? "🎶" : "🎤"}</span>
                <p className="min-w-0 flex-1 truncate text-sm">{v.name}{v.kind === "singing" && <span className="ml-2 rounded-full bg-accent-2/20 px-2 py-0.5 text-[10px] text-accent-2" title="Referencia cantada extraída de una canción generada: la misma voz en todas las canciones">voz cantada</span>}</p>
                <button onClick={() => remove(v.id)} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-red-500/20 hover:text-red-300" title="Eliminar">✕</button>
              </div>
              <p className="mt-0.5 text-[11px] text-muted" title="Medido en la grabación. La música se escribe en este registro y, al convertir, la melodía se baja una octava si queda muy por encima.">
                {v.durationSec ? `${Math.round(v.durationSec)} s · ` : ""}{new Date(v.createdAt).toLocaleDateString()}
                {v.f0MedianHz && v.singLowHz && v.singHighHz
                  ? v.kind === "singing"
                    ? ` · canta en ${hzToNote(v.f0MedianHz)} (${Math.round(v.f0MedianHz)} Hz) · rango ${hzToNote(v.singLowHz)}–${hzToNote(v.singHighHz)}`
                    : ` · hablas en ${hzToNote(v.f0MedianHz)} (${Math.round(v.f0MedianHz)} Hz) · rango cómodo ${hzToNote(v.singLowHz)}–${hzToNote(v.singHighHz)}`
                  : " · tono sin analizar (enciende el servicio de voz)"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <audio key={`${v.id}-${v.useClean}`} controls src={`/api/voices/${v.id}`} className="h-8 w-44 max-w-full" preload="none" title={v.useClean ? "Versión retocada (en uso)" : "Grabación original (en uso)"} />
                <select value={isRegister(v.register) ? v.register : ""} onChange={(e) => isRegister(e.target.value) && setRegister(v.id, e.target.value)} title="Registro vocal: decide en qué tonos se escribe la música para esta voz" className="rounded-md border border-border bg-panel-2 px-2 py-1 text-[11px] outline-none focus:border-accent-2">
                  {!isRegister(v.register) && <option value="">Registro…</option>}
                  {REGISTERS.map((r) => (
                    <option key={r} value={r}>{REGISTER_LABEL[r]}</option>
                  ))}
                </select>
                {!compact && artists.length > 0 && (
                  <select value={v.artistId ?? ""} onChange={(e) => assign(v.id, e.target.value)} title="Asignar esta voz a un artista" className="rounded-md border border-border bg-panel-2 px-2 py-1 text-[11px] outline-none focus:border-accent-2">
                    <option value="">Sin artista</option>
                    {artists.map((a) => (
                      <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                    ))}
                  </select>
                )}
              </div>
              {v.kind !== "singing" && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                {v.cleanFile ? (
                  <>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={v.useClean} onChange={(e) => setUseClean(v.id, e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent-2)]" />
                      Usar la versión retocada
                    </label>
                    <a href={`/api/voices/${v.id}?original`} target="_blank" rel="noreferrer" className="underline hover:text-fg">oír original</a>
                    <a href={`/api/voices/${v.id}?clean`} target="_blank" rel="noreferrer" className="underline hover:text-fg">oír retocada</a>
                    <button type="button" onClick={() => clean(v.id)} disabled={cleaning === v.id} className="rounded-md border border-border px-2 py-0.5 hover:text-fg disabled:opacity-50">{cleaning === v.id ? "Retocando…" : "Retocar de nuevo"}</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => clean(v.id)} disabled={cleaning === v.id} className="rounded-md border border-accent-2/60 px-2 py-0.5 text-accent-2 hover:bg-accent-2/10 disabled:opacity-50">{cleaning === v.id ? "Retocando… (~1 min)" : "✨ Retocar grabación"}</button>
                    <span>Quita ruido y sala, ecualiza, comprime y nivela. El original se conserva.</span>
                  </>
                )}
              </div>}
              <VoiceAnalysis voice={v} onUseStyle={onUseStyle} onError={onError} onChange={onChange} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted">Usa solo tu propia voz o la de alguien que te haya dado permiso. Las grabaciones se guardan únicamente en este equipo.</p>
    </div>
  );
}
