"use client";

import { useState } from "react";
import type { ArtistDTO, Scope } from "@/lib/types";

const EMOJIS = ["🎤", "🎸", "🎹", "🎧", "🥁", "🎷", "🎻", "🎺", "🪗", "🎼", "🌙", "🔥", "🌊", "⭐"];

export default function ArtistRail({ artists, scope, unassigned, onSelect, onCreated, onError }: { artists: ArtistDTO[]; scope: Scope; unassigned: number; onSelect: (s: Scope) => void; onCreated: (a: ArtistDTO) => void; onError: (e: string | null) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🎤");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/artists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, emoji }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo crear el artista");
      onCreated({ ...body.artist, songCount: 0, albumCount: 0, voiceCount: 0 });
      setName("");
      setCreating(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const item = (active: boolean, onClick: () => void, icon: string, label: string, sub?: string, image?: string | null) => (
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${active ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel hover:text-fg"}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel text-base">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {sub && <span className="block truncate text-[11px] text-muted">{sub}</span>}
      </span>
    </button>
  );

  return (
    <nav className="flex h-full flex-col gap-1 p-3">
      <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Artistas</p>
      {artists.map((a) => (
        <div key={a.id}>
          {item(scope.kind === "artist" && scope.id === a.id, () => onSelect({ kind: "artist", id: a.id }), a.emoji, a.name, [`${a.songCount} canciones`, a.albumCount ? `${a.albumCount} álbumes` : null, a.voiceCount ? "🎤 voz" : null].filter(Boolean).join(" · "), a.imageFile ? `/api/artists/${a.id}/image?v=${encodeURIComponent(a.imageFile)}` : null)}
        </div>
      ))}
      {artists.length === 0 && !creating && <p className="px-2.5 py-2 text-xs text-muted">Crea un artista para organizar voces, estilos y álbumes.</p>}

      {creating ? (
        <div className="mt-1 rounded-lg border border-border bg-panel p-2">
          <div className="mb-2 flex flex-wrap gap-1">
            {EMOJIS.map((e) => (
              <button key={e} onClick={() => setEmoji(e)} className={`h-7 w-7 rounded-md text-base ${emoji === e ? "bg-accent-2/30" : "hover:bg-panel-2"}`}>{e}</button>
            ))}
          </div>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setCreating(false); }} placeholder="Nombre del artista" className="w-full rounded-md border border-border bg-panel-2 px-2 py-1.5 text-sm outline-none focus:border-accent-2" />
          <div className="mt-2 flex gap-2">
            <button onClick={create} disabled={saving || !name.trim()} className="rounded-md bg-accent-2 px-3 py-1 text-xs font-medium text-white disabled:opacity-40">Crear</button>
            <button onClick={() => setCreating(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg">Cancelar</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setCreating(true)} className="mt-1 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-sm text-muted hover:border-accent-2 hover:text-fg">+ Nuevo artista</button>
      )}

      <div className="mt-auto border-t border-border pt-2">
        {item(scope.kind === "market", () => onSelect({ kind: "market" }), "📈", "Mercado", "tendencias e ideas")}
        {unassigned > 0 && item(scope.kind === "none", () => onSelect({ kind: "none" }), "📁", "Sin artista", `${unassigned} canciones`)}
        {item(scope.kind === "all", () => onSelect({ kind: "all" }), "🎵", "Todo", "todas las canciones")}
      </div>
    </nav>
  );
}
