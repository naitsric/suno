"use client";

import { useEffect, useState } from "react";
import VoicePanel from "./VoicePanel";
import ImageGenerator from "./ImageGenerator";
import { LANGUAGES, type ArtistDTO, type VoiceDTO } from "@/lib/types";

export default function ArtistProfile({ artist, voices, onUpdated, onDeleted, onVoicesChanged, onError, onUseStyle }: { artist: ArtistDTO; voices: VoiceDTO[]; onUpdated: (a: ArtistDTO) => void; onDeleted: (id: string) => void; onVoicesChanged: () => void; onError: (e: string | null) => void; onUseStyle?: (style: string, genre: string, brief: string) => void }) {
  const [name, setName] = useState(artist.name);
  const [style, setStyle] = useState(artist.style);
  const [description, setDescription] = useState(artist.description);
  const [language, setLanguage] = useState(artist.vocalLanguage);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setName(artist.name);
      setStyle(artist.style);
      setDescription(artist.description);
      setLanguage(artist.vocalLanguage);
      setConfirmDelete(false);
    }, 0);
    return () => window.clearTimeout(id);
  }, [artist.id, artist.name, artist.style, artist.description, artist.vocalLanguage]);

  const dirty = name !== artist.name || style !== artist.style || description !== artist.description || language !== artist.vocalLanguage;

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/artists/${artist.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo guardar");
      onUpdated({ ...artist, ...data.artist });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const res = await fetch(`/api/artists/${artist.id}`, { method: "DELETE" });
    if (res.ok) onDeleted(artist.id);
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <Field label="Nombre">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Estilo por defecto" hint="Se precarga al crear canciones">
          <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2} placeholder="indie pop, dreamy, female vocals, synths" className={inputCls} />
        </Field>
        <Field label="Quién es" hint="Temas, tono, referencias. Guía las letras en modo simple">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Cantautora de Bogotá, letras sobre la ciudad y la nostalgia, voz íntima…" className={inputCls} />
        </Field>
        <Field label="Idioma de la voz">
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </Field>
        <button onClick={() => patch({ name, style, description, vocalLanguage: language })} disabled={!dirty || saving} className="self-start rounded-lg bg-accent-2 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {saving ? "Guardando…" : "Guardar perfil"}
        </button>
      </section>

      <LoraSection artist={artist} onChanged={onVoicesChanged} />

      <section className="border-t border-border pt-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Imagen de {artist.name}</h3>
          <span className="text-[11px] text-muted">OpenAI gpt-image-1</span>
        </div>
        <ImageGenerator
          key={artist.id}
          kind="artist"
          id={artist.id}
          imageUrl={artist.imageFile ? `/api/artists/${artist.id}/image?v=${encodeURIComponent(artist.imageFile)}` : null}
          placeholder={artist.emoji}
          onGenerated={(a) => onUpdated({ ...artist, ...(a as Partial<ArtistDTO>) })}
          onError={onError}
        />
      </section>

      <section className="border-t border-border pt-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Voz de {artist.name}</h3>
          <span className="text-[11px] text-muted">opcional</span>
        </div>
        {voices.length > 1 && (
          <Field label="Voz por defecto">
            <select value={artist.defaultVoiceId ?? ""} onChange={(e) => patch({ defaultVoiceId: e.target.value || null })} className={inputCls}>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </Field>
        )}
        <div className="mt-3">
          <VoicePanel voices={voices} artistId={artist.id} onChange={onVoicesChanged} onError={onError} onUseStyle={onUseStyle} compact />
        </div>
      </section>

      <section className="border-t border-border pt-4">
        {confirmDelete ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Se borran el artista y sus álbumes; las canciones y voces se conservan sin artista.</span>
            <button onClick={remove} className="rounded-md bg-red-500/20 px-3 py-1.5 text-red-300">Eliminar</button>
            <button onClick={() => setConfirmDelete(false)} className="px-2 text-muted hover:text-fg">Cancelar</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="text-xs text-muted hover:text-red-300">Eliminar artista…</button>
        )}
      </section>
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

type LoraStatus = { status: string; path: string | null; progress: string; error: string | null; tag: string | null; songs: number; running: boolean; training: { current_epoch: number; current_step: number; current_loss: number | null; estimated_time_remaining: number } | null };

/** Trains / shows the artist's ACE-Step LoRA (the model sings with the artist's voice; no conversion). */
function LoraSection({ artist, onChanged }: { artist: ArtistDTO; onChanged: () => void }) {
  const [info, setInfo] = useState<LoraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = info?.status === "preparing" || info?.status === "training";
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/artists/${artist.id}/lora`, { cache: "no-store" });
        if (res.ok && alive) setInfo((await res.json()) as LoraStatus);
      } catch {
        /* offline */
      }
    };
    load();
    const t = setInterval(load, active ? 10000 : 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [artist.id, active]);
  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/artists/${artist.id}/lora`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ epochs: 10 }) : undefined });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Error");
      setInfo(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border-t border-border pt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Voz entrenada en el motor (LoRA)</h3>
        <span className="text-[11px] text-muted">{info ? `${info.songs} canciones con letra` : ""}</span>
      </div>
      <p className="mb-2 text-xs text-muted">
        ACE-Step aprende la voz de {artist.name} de sus propias canciones y las nuevas salen cantadas con ella desde el modelo, sin conversión ni vocoder. Necesita 3+ canciones terminadas y apaga el motor mientras entrena (10 épocas ≈ 1–3 h).
      </p>
      {info?.status === "done" && <p className="mb-2 text-xs text-accent">✅ {info.progress} · tag «{info.tag}». Actívalo en el panel de crear («Cantar con el LoRA»).</p>}
      {active && <p className="mb-2 text-xs text-amber-300">⏳ {info?.progress}{info?.training?.estimated_time_remaining ? ` · quedan ~${Math.round(info.training.estimated_time_remaining / 60)} min` : ""}</p>}
      {info?.status === "failed" && <p className="mb-2 text-xs text-red-300">Falló: {info.error}</p>}
      {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        {!active && (
          <button onClick={() => act("POST")} disabled={busy || (info?.songs ?? 0) < 3} className="rounded-lg bg-accent-2 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
            {info?.status === "done" ? "Volver a entrenar" : "Entrenar la voz (LoRA)"}
          </button>
        )}
        {active && (
          <button onClick={() => act("DELETE")} disabled={busy} className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40">
            Parar
          </button>
        )}
      </div>
    </section>
  );
}
