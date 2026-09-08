"use client";

import { useEffect, useState } from "react";

/**
 * Prompt → image with the OpenAI image API, for an artist portrait or an album cover. The prompt is
 * prefilled from the entity (or the last prompt used) and always editable; generation is explicit.
 */
export default function ImageGenerator({ kind, id, imageUrl, placeholder, onGenerated, onError, compact = false }: {
  kind: "artist" | "album";
  id: string;
  imageUrl: string | null;
  placeholder?: string;
  onGenerated: (entity: unknown) => void;
  onError: (e: string | null) => void;
  compact?: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const base = `/api/${kind === "artist" ? "artists" : "albums"}/${id}/image`;

  useEffect(() => {
    let alive = true;
    fetch(`${base}?suggest`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { prompt?: string; configured?: boolean }) => {
        if (!alive) return;
        setPrompt(b.prompt ?? "");
        setConfigured(b.configured !== false);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [base]);

  const generate = async () => {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, quality }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo generar la imagen");
      onGenerated(body.artist ?? body.album);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cost = { low: "≈ 0,01 USD", medium: "≈ 0,04 USD", high: "≈ 0,17 USD" }[quality];
  return (
    <div className={`flex gap-3 ${compact ? "items-start" : "flex-col sm:flex-row"}`}>
      <div className={`${compact ? "h-20 w-20" : "h-32 w-32"} shrink-0 overflow-hidden rounded-xl bg-panel-2 flex items-center justify-center text-3xl`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" /> : <span>{placeholder ?? "🖼️"}</span>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={compact ? 3 : 4} placeholder="Describe la imagen…" className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs leading-relaxed outline-none focus:border-accent-2" />
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={generate} disabled={busy || !configured || prompt.trim().length < 5} className="rounded-lg bg-accent-2 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
            {busy ? "Generando… (~20 s)" : imageUrl ? "Regenerar imagen" : "Generar imagen"}
          </button>
          <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)} className="rounded-md border border-border bg-panel-2 px-2 py-1 text-[11px] outline-none focus:border-accent-2" title="Calidad de gpt-image-1">
            <option value="low">Calidad baja</option>
            <option value="medium">Calidad media</option>
            <option value="high">Calidad alta</option>
          </select>
          <span className="text-[11px] text-muted">{cost} por imagen</span>
          {imageUrl && <a href={imageUrl} target="_blank" rel="noreferrer" className="text-[11px] text-muted underline hover:text-fg">ver grande</a>}
        </div>
        {!configured && <p className="text-[11px] text-amber-300">Falta OPENAI_API_KEY en web/.env.local (y reiniciar la web).</p>}
      </div>
    </div>
  );
}
