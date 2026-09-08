"use client";

import { useState } from "react";
import { coverGradient, fmtTime, type AlbumDTO, type ArtistDTO, type SongDTO, type VoiceDTO } from "@/lib/types";
import { MASTER_LABELS, MASTER_PRESETS, type MasterPreset } from "@/lib/master-presets";
import ImageGenerator from "./ImageGenerator";

type LibraryProps = {
  songs: SongDTO[];
  current: SongDTO | null;
  artist: ArtistDTO | null;
  artists: ArtistDTO[];
  voices: VoiceDTO[];
  onVoicesChanged?: () => void;
  albums: AlbumDTO[];
  onPlay: (s: SongDTO) => void;
  onDelete: (id: string) => void;
  onUpdated: (s: SongDTO) => void;
  onCreated: (s: SongDTO[]) => void;
  onAlbumsChanged: () => void;
  onError: (e: string | null) => void;
  playerTime: number | null;
};

export default function Library({ songs, current, artist, artists, voices, albums, playerTime, onPlay, onDelete, onUpdated, onCreated, onAlbumsChanged, onVoicesChanged, onError }: LibraryProps) {
  const [albumFilter, setAlbumFilter] = useState<string | "all" | "none">("all");
  const [coverEditor, setCoverEditor] = useState<string | null>(null);
  const [newAlbum, setNewAlbum] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const artistAlbums = artist ? albums.filter((a) => a.artistId === artist.id) : [];

  const createAlbum = async () => {
    if (!artist || !newAlbum?.trim()) return;
    const res = await fetch(`/api/artists/${artist.id}/albums`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newAlbum }) });
    const body = await res.json();
    if (!res.ok) return onError(body.error ?? "No se pudo crear el álbum");
    setNewAlbum(null);
    setAlbumFilter(body.album.id);
    onAlbumsChanged();
  };
  const renameAlbum = async () => {
    if (!renaming) return;
    const res = await fetch(`/api/albums/${renaming.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: renaming.name }) });
    if (!res.ok) return onError("No se pudo renombrar");
    setRenaming(null);
    onAlbumsChanged();
  };
  const deleteAlbum = async (id: string) => {
    await fetch(`/api/albums/${id}`, { method: "DELETE" });
    if (albumFilter === id) setAlbumFilter("all");
    onAlbumsChanged();
  };

  const visible = albumFilter === "all" ? songs : songs.filter((s) => (albumFilter === "none" ? !s.albumId : s.albumId === albumFilter));
  const chip = (active: boolean, onClick: () => void, label: string) => (
    <button onClick={onClick} className={`rounded-full border px-3 py-1 text-xs transition ${active ? "border-accent-2 bg-accent-2/20 text-fg" : "border-border text-muted hover:text-fg"}`}>{label}</button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          {artist?.imageFile && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/artists/${artist.id}/image?v=${encodeURIComponent(artist.imageFile)}`} alt="" className="h-7 w-7 rounded-md object-cover" />
          )}
          <span>{artist ? `${artist.imageFile ? "" : `${artist.emoji} `}${artist.name}` : "Biblioteca"} · {visible.length}</span>
        </h2>
        {artist && (
          <>
            {chip(albumFilter === "all", () => setAlbumFilter("all"), "Todo")}
            {artistAlbums.map((a) => (
              <span key={a.id} className="group inline-flex items-center">
                {renaming?.id === a.id ? (
                  <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") renameAlbum(); if (e.key === "Escape") setRenaming(null); }} onBlur={renameAlbum} className="w-36 rounded-full border border-accent-2 bg-panel px-3 py-1 text-xs outline-none" />
                ) : (
                  <>
                    {chip(albumFilter === a.id, () => setAlbumFilter(a.id), `💿 ${a.name} · ${songs.filter((s) => s.albumId === a.id).length}`)}
                    {albumFilter === a.id && (
                      <span className="ml-1 flex gap-0.5">
                        <button onClick={() => setCoverEditor(coverEditor === a.id ? null : a.id)} className="rounded px-1 text-[11px] text-muted hover:text-fg" title="Portada del álbum (OpenAI)">🖼</button>
                        <button onClick={() => setRenaming({ id: a.id, name: a.name })} className="rounded px-1 text-[11px] text-muted hover:text-fg" title="Renombrar">✎</button>
                        <button onClick={() => deleteAlbum(a.id)} className="rounded px-1 text-[11px] text-muted hover:text-red-300" title="Eliminar álbum (las canciones se conservan)">✕</button>
                      </span>
                    )}
                  </>
                )}
              </span>
            ))}
            {songs.some((s) => !s.albumId) && artistAlbums.length > 0 && chip(albumFilter === "none", () => setAlbumFilter("none"), "Sin álbum")}
            {newAlbum === null ? (
              <button onClick={() => setNewAlbum("")} className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted hover:border-accent-2 hover:text-fg">+ Álbum</button>
            ) : (
              <input autoFocus value={newAlbum} onChange={(e) => setNewAlbum(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createAlbum(); if (e.key === "Escape") setNewAlbum(null); }} placeholder="Nombre del álbum ⏎" className="w-44 rounded-full border border-accent-2 bg-panel px-3 py-1 text-xs outline-none" />
            )}
          </>
        )}
      </div>

      {coverEditor && artistAlbums.some((a) => a.id === coverEditor) && (
        <div className="rounded-xl border border-border bg-panel p-3 text-xs">
          <p className="mb-2 font-medium uppercase tracking-wide text-muted">Portada · {artistAlbums.find((a) => a.id === coverEditor)?.name}</p>
          <ImageGenerator
            key={coverEditor}
            kind="album"
            id={coverEditor}
            compact
            placeholder="💿"
            imageUrl={(() => {
              const a = artistAlbums.find((x) => x.id === coverEditor);
              return a?.imageFile ? `/api/albums/${a.id}/image?v=${encodeURIComponent(a.imageFile)}` : null;
            })()}
            onGenerated={() => onAlbumsChanged()}
            onError={onError}
          />
        </div>
      )}

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted">
          <div className="mb-3 h-16 w-16 rounded-2xl opacity-60" style={{ background: coverGradient(artist?.id ?? "empty") }} />
          <p className="text-sm">{artist ? `${artist.name} todavía no tiene canciones${albumFilter !== "all" ? " aquí" : ""}.` : "Todavía no hay canciones."}</p>
          <p className="text-xs">Descríbela a la izquierda y pulsa «Crear canción».</p>
        </div>
      ) : (
        visible.map((s) => (
          <SongCard key={s.id} song={s} active={current?.id === s.id} artists={artists} voices={voices} onVoicesChanged={onVoicesChanged} onAlbumsChanged={onAlbumsChanged} albums={albums} songs={songs} playerTime={current?.id === s.id ? playerTime : null} onPlay={() => onPlay(s)} onDelete={() => onDelete(s.id)} onUpdated={onUpdated} onCreated={onCreated} onError={onError} />
        ))
      )}
    </div>
  );
}

function SongCard({ song, active, artists, voices, onVoicesChanged, onAlbumsChanged, albums, songs, playerTime, onPlay, onDelete, onUpdated, onCreated, onError }: { song: SongDTO; active: boolean; artists: ArtistDTO[]; voices: VoiceDTO[]; onVoicesChanged?: () => void; onAlbumsChanged?: () => void; albums: AlbumDTO[]; songs: SongDTO[]; playerTime: number | null; onPlay: () => void; onDelete: () => void; onUpdated: (s: SongDTO) => void; onCreated: (s: SongDTO[]) => void; onError: (e: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const parent = song.parentId ? songs.find((x) => x.id === song.parentId) ?? null : null;
  const songArtist = artists.find((a) => a.id === song.artistId) ?? null;
  const songAlbum = albums.find((a) => a.id === song.albumId) ?? null;
  const coverUrl = songAlbum?.imageFile ? `/api/albums/${songAlbum.id}/image?v=${encodeURIComponent(songAlbum.imageFile)}` : songArtist?.imageFile ? `/api/artists/${songArtist.id}/image?v=${encodeURIComponent(songArtist.imageFile)}` : null;

  const move = async (patch: { artistId?: string | null; albumId?: string | null }) => {
    const res = await fetch(`/api/songs/${song.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) return onError(body.error ?? "No se pudo mover");
    onUpdated(body.song as SongDTO);
  };
  const [newAlbumName, setNewAlbumName] = useState<string | null>(null);
  const artistAlbums = albums.filter((a) => a.artistId === song.artistId);

  /** Inline album picker on the card: pick an album, "Sin álbum", or create one and move the song into it. */
  const chooseAlbum = async (value: string) => {
    if (value === "__new__") return setNewAlbumName("");
    await move({ albumId: value || null });
  };
  const createAlbumAndMove = async () => {
    const name = (newAlbumName ?? "").trim();
    setNewAlbumName(null);
    if (!name || !song.artistId) return;
    const res = await fetch(`/api/artists/${song.artistId}/albums`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await res.json();
    if (!res.ok) return onError(body.error ?? "No se pudo crear el álbum");
    onAlbumsChanged?.();
    await move({ albumId: body.album.id });
  };
  const [processing, setProcessing] = useState(false);
  const [ppError, setPpError] = useState<string | null>(null);
  const [enhance, setEnhance] = useState(song.enhanced);
  const [preset, setPreset] = useState<MasterPreset>(song.masterPreset as MasterPreset);
  const [autotune, setAutotune] = useState(song.autotune);
  const [reconverting, setReconverting] = useState(false);
  const [voiceId, setVoiceId] = useState(song.voiceId ?? "");
  const [makingVoice, setMakingVoice] = useState(false);
  const artistVoices = voices.filter((v) => v.artistId === song.artistId || (!song.artistId && !v.artistId));

  /** Turns this song's singer into a reusable sung reference (synthetic singer) for the artist. */
  const makeVoice = async () => {
    setMakingVoice(true);
    setPpError(null);
    try {
      const res = await fetch("/api/voices/from-song", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ songId: song.id }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo crear la voz");
      onVoicesChanged?.();
      setVoiceId(body.voice.id);
    } catch (err) {
      setPpError(err instanceof Error ? err.message : String(err));
    } finally {
      setMakingVoice(false);
    }
  };

  const reconvert = async () => {
    setReconverting(true);
    setPpError(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ autotune, ...(voiceId && voiceId !== song.voiceId ? { voiceId } : {}) }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo reconvertir");
      onUpdated(body.song as SongDTO);
    } catch (err) {
      setPpError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconverting(false);
    }
  };

  const dropVoice = async () => {
    setReconverting(true);
    setPpError(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/voice`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo quitar la voz");
      setVoiceId("");
      onUpdated(body.song as SongDTO);
    } catch (err) {
      setPpError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconverting(false);
    }
  };

  const applyPostProduction = async () => {
    setProcessing(true);
    setPpError(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/master`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset, enhance }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo procesar");
      onUpdated(body.song as SongDTO);
    } catch (err) {
      setPpError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };
  const busy = song.status === "queued" || song.status === "generating" || song.status === "converting";
  const tags = song.style.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6);

  return (
    <article className={`rounded-xl border bg-panel p-3 transition ${active ? "border-accent-2" : "border-border"}`}>
      <div className="flex gap-3">
        <button onClick={onPlay} disabled={song.status !== "done"} className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg disabled:cursor-default" style={{ background: coverGradient(song.taskId ?? song.id) }} aria-label="Reproducir">
          {coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
          {song.status === "done" && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
              <PlayIcon />
            </span>
          )}
          {busy && (
            <span className="absolute inset-0 flex items-end justify-center gap-0.5 bg-black/30 pb-2">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="pulse w-1 rounded bg-white" style={{ height: 8 + i * 4, animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          )}
          {song.status === "failed" && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xl">⚠️</span>}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate font-medium">
                {song.title}
                <span className="ml-2 text-xs text-muted">v{song.variant + 1}</span>
                {song.originalAudioFile && <span className="ml-2 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] text-accent" title="Cantada con tu voz">🎤 mi voz</span>}
                {song.status === "done" && song.rawAudioFile && (song.enhanced || song.masterPreset !== "off") && (
                  <span className="ml-2 rounded-full bg-accent-2/20 px-2 py-0.5 text-[10px] text-accent-2" title="Post-producción aplicada">
                    ✨ {[song.enhanced ? "Realce IA" : null, song.masterPreset !== "off" ? MASTER_LABELS[song.masterPreset as MasterPreset]?.split(" ")[0] : null].filter(Boolean).join(" + ")}
                  </span>
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                {songArtist && <span>{songArtist.emoji} {songArtist.name}</span>}
                {songArtist && (
                  newAlbumName !== null ? (
                    <input autoFocus value={newAlbumName} onChange={(e) => setNewAlbumName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createAlbumAndMove(); if (e.key === "Escape") setNewAlbumName(null); }} onBlur={createAlbumAndMove} placeholder="Nombre del álbum ⏎" className="w-40 rounded-md border border-accent-2 bg-panel-2 px-2 py-0.5 text-[11px] outline-none" />
                  ) : (
                    <select value={song.albumId ?? ""} onChange={(e) => chooseAlbum(e.target.value)} title="Álbum de esta canción" className={`max-w-44 truncate rounded-md border border-border bg-panel-2 px-1.5 py-0.5 text-[11px] outline-none focus:border-accent-2 ${songAlbum ? "text-fg" : ""}`}>
                      <option value="">💿 Sin álbum</option>
                      {artistAlbums.map((a) => (
                        <option key={a.id} value={a.id}>💿 {a.name}</option>
                      ))}
                      <option value="__new__">＋ Nuevo álbum…</option>
                    </select>
                  )
                )}
                <span className="truncate">{[song.mode === "simple" ? "Simple" : "Personalizado", song.instrumental ? "Instrumental" : song.vocalLanguage.toUpperCase(), song.duration ? fmtTime(song.duration) : null, song.bpm ? `${song.bpm} bpm` : null, song.keyScale].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {song.status === "done" && song.originalAudioFile && (
                <a href={`/api/songs/${song.id}/audio?original&download`} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg" title="Descargar la versión con la voz original">orig.</a>
              )}
              {song.status === "done" && (
                <a href={`/api/songs/${song.id}/audio?download`} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-fg" title="Descargar">⤓</a>
              )}
              <button onClick={() => setOpen((v) => !v)} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-fg" title="Letra y detalles">{open ? "▴" : "▾"}</button>
              <button onClick={onDelete} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-red-500/20 hover:text-red-300" title="Eliminar">✕</button>
            </div>
          </div>

          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} className="rounded-full bg-panel-2 px-2 py-0.5 text-[11px] text-muted">{t}</span>
              ))}
            </div>
          )}

          {song.editInstruction && (
            <p className="mt-1.5 truncate text-[11px] text-muted" title={song.editInstruction}>
              ✏️ {song.editOp === "repaint" ? "Tramo regenerado" : "Cover"}{parent ? ` de «${parent.title}»` : ""}: “{song.editInstruction}”
            </p>
          )}
          {busy && <p className="mt-2 truncate text-xs text-accent-2" title={song.progress}>{song.status === "queued" ? "⏳ " : song.status === "converting" ? "" : "🎛️ "}{song.progress || (song.status === "converting" ? "🎤 Convirtiendo voz…" : "Generando…")}</p>}
          {song.status === "failed" && <p className="mt-2 text-xs text-red-300">{song.error ?? "Falló la generación"}</p>}
          {song.status === "done" && song.error && <p className="mt-2 text-xs text-amber-300">{song.error}</p>}
        </div>
      </div>

      {open && (
        <div className="mt-3 grid gap-3 border-t border-border pt-3 text-xs md:grid-cols-2">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="font-medium uppercase tracking-wide text-muted">Artista</span>
              <select value={song.artistId ?? ""} onChange={(e) => move({ artistId: e.target.value || null, albumId: null })} className="rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent-2">
                <option value="">Sin artista</option>
                {artists.map((a) => (
                  <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                ))}
              </select>
              {song.artistId && (
                <>
                  <span className="font-medium uppercase tracking-wide text-muted">Álbum</span>
                  <select value={song.albumId ?? ""} onChange={(e) => move({ albumId: e.target.value || null })} className="rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent-2">
                    <option value="">Sin álbum</option>
                    {albums.filter((a) => a.artistId === song.artistId).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <p className="mb-1 font-medium uppercase tracking-wide text-muted">Estilo</p>
            <p className="whitespace-pre-wrap text-fg/90">{song.style || "—"}</p>
            {song.description && (
              <>
                <p className="mt-3 mb-1 font-medium uppercase tracking-wide text-muted">Descripción</p>
                <p className="whitespace-pre-wrap text-fg/90">{song.description}</p>
              </>
            )}
          </div>
          <div>
            {song.status === "done" && song.audioFile && (
              <div className="mb-3 rounded-lg border border-border bg-panel-2/60 p-3">
                <p className="mb-2 font-medium uppercase tracking-wide text-muted">✨ Post-producción</p>
                <label className="flex items-center justify-between gap-3 py-1">
                  <span>
                    <span className="block text-fg">Realce IA (Apollo)</span>
                    <span className="block text-[11px] text-muted">Restaura detalle y quita artefactos del modelo · ~1 min por canción</span>
                  </span>
                  <input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} className="h-4 w-4 accent-[var(--accent-2)]" />
                </label>
                <label className="flex items-center justify-between gap-3 py-1">
                  <span>
                    <span className="block text-fg">Masterización</span>
                    <span className="block text-[11px] text-muted">EQ, compresión y loudness</span>
                  </span>
                  <select value={preset} onChange={(e) => setPreset(e.target.value as MasterPreset)} className="rounded-md border border-border bg-panel px-2 py-1 text-xs outline-none focus:border-accent-2">
                    {MASTER_PRESETS.map((p) => (
                      <option key={p} value={p}>{MASTER_LABELS[p]}</option>
                    ))}
                  </select>
                </label>
                {!song.instrumental && (
                  <label className="flex items-center justify-between gap-3 py-1">
                    <span>
                      <span className="block text-fg">🎶 Convertir esta voz en la voz del artista</span>
                      <span className="block text-[11px] text-muted">Extrae los mejores 30 s de la voz que cantó el modelo y los guarda como voz cantada del artista: la misma voz en todas sus canciones · ~1 min</span>
                    </span>
                    <button onClick={makeVoice} disabled={makingVoice} className="shrink-0 rounded-md border border-accent-2/60 px-2 py-1 text-[11px] text-fg hover:bg-accent-2/20 disabled:opacity-40">{makingVoice ? "Extrayendo…" : "Usar como voz"}</button>
                  </label>
                )}
                {(song.voiceId || artistVoices.length > 0) && !song.instrumental && (
                  <label className="flex items-center justify-between gap-3 py-1">
                    <span>
                      <span className="block text-fg">Voz y afinado</span>
                      <span className="block text-[11px] text-muted">Vuelve a convertir con la voz elegida{autotune ? `, corrigiendo la entonación${song.keyScale ? ` a ${song.keyScale}` : ""}` : ""} · 1–3 min</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className="max-w-36 rounded-md border border-border bg-panel px-2 py-1 text-xs outline-none focus:border-accent-2" title="Voz con la que se reconvierte">
                        {!song.voiceId && <option value="">Elige una voz</option>}
                        {artistVoices.map((v) => (
                          <option key={v.id} value={v.id}>{v.kind === "singing" ? "🎶 " : "🎤 "}{v.name}</option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 text-[11px] text-muted" title="Afinar la voz (autotune)"><input type="checkbox" checked={autotune} onChange={(e) => setAutotune(e.target.checked)} className="h-4 w-4 accent-[var(--accent-2)]" />afinar</label>
                      <button onClick={reconvert} disabled={reconverting || !voiceId} className="rounded-md border border-accent-2/60 px-2 py-1 text-[11px] text-fg hover:bg-accent-2/20 disabled:opacity-40" title="Reconvierte desde el audio original del modelo">
                        {reconverting ? "Enviando…" : song.voiceId ? "Reconvertir" : "Convertir"}
                      </button>
                      {song.voiceId && (
                        <button onClick={dropVoice} disabled={reconverting} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-fg disabled:opacity-40" title="Vuelve a la voz con la que cantó el modelo; borra la conversión">
                          Quitar voz
                        </button>
                      )}
                    </span>
                  </label>
                )}
                <div className="mt-2 flex items-center gap-3">
                  <button onClick={applyPostProduction} disabled={processing || (enhance === song.enhanced && preset === song.masterPreset)} className="rounded-md bg-accent-2 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                    {processing ? "Procesando…" : "Aplicar"}
                  </button>
                  {song.rawAudioFile && <a href={`/api/songs/${song.id}/audio?raw&download`} className="text-muted hover:text-fg">descargar sin procesar</a>}
                  <span className="text-[11px] text-muted">Siempre se parte del audio original del modelo; puedes volver a «Sin procesar» cuando quieras.</span>
                </div>
                {ppError && <p className="mt-1 text-red-300">{ppError}</p>}
              </div>
            )}
            {song.status === "done" && song.audioFile && <VideoSection song={song} onUpdated={onUpdated} />}
            {song.status === "done" && song.audioFile && <EditSection song={song} playerTime={playerTime} onCreated={onCreated} onError={onError} />}
            <p className="mb-1 font-medium uppercase tracking-wide text-muted">Letra</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fg/90">{song.lyrics || "—"}</pre>
          </div>
        </div>
      )}
    </article>
  );
}

function PlayIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
  );
}

type EditPlan = { op: "cover" | "repaint"; style: string; lyrics: string; strength: number; start: number | null; end: number | null; summary: string };

const EXAMPLES = ["más batería y percusión", "hazla más rock, guitarras distorsionadas", "más lenta y acústica", "cambia el coro por algo más épico", "quita los sintetizadores", "que el final sea más suave"];

function EditSection({ song, playerTime, onCreated, onError }: { song: SongDTO; playerTime: number | null; onCreated: (s: SongDTO[]) => void; onError: (e: string | null) => void }) {
  const [instruction, setInstruction] = useState("");
  const [useRange, setUseRange] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.round(song.duration ?? 30));
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const dur = Math.round(song.duration ?? 0);

  const getPlan = async () => {
    setPlanning(true);
    onError(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, start: useRange ? start : null, end: useRange ? end : null }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo interpretar");
      setPlan(body.plan as EditPlan);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  };

  const run = async () => {
    if (!plan) return;
    setRunning(true);
    onError(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, plan }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo aplicar la edición");
      onCreated(body.songs as SongDTO[]);
      setPlan(null);
      setInstruction("");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-border bg-panel-2/60 p-3">
      <p className="mb-2 font-medium uppercase tracking-wide text-muted">✏️ Editar con un prompt</p>
      <textarea value={instruction} onChange={(e) => { setInstruction(e.target.value); setPlan(null); }} rows={2} placeholder="Qué quieres cambiar: “más batería”, “el coro más épico”, “más lenta y acústica”…" className="w-full rounded-md border border-border bg-panel px-2 py-1.5 text-xs outline-none placeholder:text-muted/60 focus:border-accent-2" />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => { setInstruction(e); setPlan(null); }} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted hover:border-accent-2 hover:text-fg">{e}</button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={useRange} onChange={(e) => { setUseRange(e.target.checked); setPlan(null); }} className="accent-[var(--accent-2)]" /> Solo un tramo
        </label>
        {useRange && (
          <>
            <input type="number" min={0} max={dur} value={start} onChange={(e) => { setStart(Number(e.target.value)); setPlan(null); }} className="w-16 rounded-md border border-border bg-panel px-2 py-1 text-xs outline-none" /> s →
            <input type="number" min={0} max={dur} value={end} onChange={(e) => { setEnd(Number(e.target.value)); setPlan(null); }} className="w-16 rounded-md border border-border bg-panel px-2 py-1 text-xs outline-none" /> s
            {playerTime !== null && (
              <span className="flex gap-1">
                <button type="button" onClick={() => setStart(Math.floor(playerTime))} className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted hover:text-fg" title="Usar la posición actual del reproductor como inicio">inicio = {fmtTime(playerTime)}</button>
                <button type="button" onClick={() => setEnd(Math.ceil(playerTime))} className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted hover:text-fg" title="Usar la posición actual del reproductor como fin">fin = {fmtTime(playerTime)}</button>
              </span>
            )}
          </>
        )}
        <button type="button" onClick={getPlan} disabled={planning || instruction.trim().length < 2} className="ml-auto rounded-md border border-accent-2/60 px-3 py-1 text-xs text-fg hover:bg-accent-2/20 disabled:opacity-40">
          {planning ? "Interpretando…" : "Interpretar"}
        </button>
      </div>

      {plan && (
        <div className="mt-3 rounded-md border border-accent-2/40 bg-panel p-2.5">
          <p className="text-fg">{plan.summary}</p>
          <div className="mt-2 grid gap-2 md:grid-cols-[auto_1fr] md:items-center">
            <span className="text-muted">Operación</span>
            <select value={plan.op} onChange={(e) => setPlan({ ...plan, op: e.target.value as EditPlan["op"] })} className="rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none">
              <option value="cover">Cover · toda la canción, conserva melodía</option>
              <option value="repaint">Repaint · solo el tramo {plan.start ?? 0}s–{plan.end ?? dur}s</option>
            </select>
            <span className="text-muted">Estilo nuevo</span>
            <input value={plan.style} onChange={(e) => setPlan({ ...plan, style: e.target.value })} className="rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none" />
            {plan.op === "cover" && (
              <>
                <span className="text-muted">Fidelidad al original · {plan.strength.toFixed(2)}</span>
                <input type="range" min={0.3} max={1} step={0.05} value={plan.strength} onChange={(e) => setPlan({ ...plan, strength: Number(e.target.value) })} className="accent-[var(--accent-2)]" />
              </>
            )}
            {plan.op === "repaint" && (
              <>
                <span className="text-muted">Tramo</span>
                <span className="flex items-center gap-1">
                  <input type="number" min={0} max={dur} value={plan.start ?? 0} onChange={(e) => setPlan({ ...plan, start: Number(e.target.value) })} className="w-16 rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none" /> s →
                  <input type="number" min={0} max={dur} value={plan.end ?? dur} onChange={(e) => setPlan({ ...plan, end: Number(e.target.value) })} className="w-16 rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none" /> s
                </span>
              </>
            )}
          </div>
          {plan.lyrics !== song.lyrics && <p className="mt-2 text-[11px] text-amber-300">La letra también cambia. Revísala en la nueva versión.</p>}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={run} disabled={running} className="rounded-md bg-accent-2 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{running ? "Enviando…" : "Aplicar edición"}</button>
            <span className="text-[11px] text-muted">Se crea una versión nueva; la original no se toca.{song.voiceId ? " La voz se vuelve a convertir sola." : ""}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Stills video: one Pixar image per section with a consistent character, Ken Burns motion, cut on the bars. */
function VideoSection({ song, onUpdated }: { song: SongDTO; onUpdated: (s: SongDTO) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState(true);
  const [provider, setProvider] = useState<"openai" | "local">("openai");
  const status = song.videoStatus ?? "none";
  const scenes = (() => {
    try {
      return song.storyboard ? (JSON.parse(song.storyboard) as { scenes: { section: string; prompt: string; duration: number }[] }).scenes : [];
    } catch {
      return [];
    }
  })();

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/songs/${song.id}/video`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subtitles: subtitles && !song.instrumental, provider }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo crear el video");
      onUpdated(body.song as SongDTO);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sceneCount = Math.min(18, Math.max(6, Math.round((song.duration ?? 180) / 17)));
  const minutes = provider === "openai" ? Math.max(3, Math.round(sceneCount * 0.4) + 2) : Math.max(3, Math.round(((song.duration ?? 180) / 15) * 1.1));
  const cost = provider === "openai" ? ` · ≈ ${(sceneCount * 0.06).toFixed(2)} USD` : "";
  const providerSelect = (
    <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} className="rounded-md border border-border bg-panel px-2 py-1 text-[11px] outline-none focus:border-accent-2" title="Con qué se generan las imágenes">
      <option value="openai">Imágenes: OpenAI</option>
      <option value="local">Imágenes: local (Wan)</option>
    </select>
  );
  return (
    <div className="mb-3 rounded-lg border border-border bg-panel-2/60 p-3">
      <p className="mb-2 font-medium uppercase tracking-wide text-muted">🎬 Video de imágenes</p>
      {status === "done" && song.videoFile ? (
        <div className="flex flex-col gap-2">
          <video controls preload="metadata" src={`/api/songs/${song.id}/video`} className="w-full rounded-md bg-black" />
          <div className="flex items-center gap-3">
            <a href={`/api/songs/${song.id}/video?download`} className="text-muted hover:text-fg">descargar MP4</a>
            {!song.instrumental && (
              <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} className="h-4 w-4 accent-[var(--accent-2)]" />con letra</label>
            )}
            {providerSelect}
            <button onClick={start} disabled={busy} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-fg disabled:opacity-40">{busy ? "Enviando…" : "Regenerar"}</button>
            {scenes.length > 0 && <span className="text-[11px] text-muted">{scenes.length} escenas{cost}</span>}
          </div>
        </div>
      ) : status === "queued" || status === "rendering" ? (
        <div className="flex flex-col gap-1">
          <p className="text-fg">{song.videoProgress || "🎬 En cola"}</p>
          <p className="text-[11px] text-muted">Unos {minutes} min: una imagen por sección con el mismo personaje, luego el montaje.{song.videoProgress?.includes("OpenAI") ? "" : " Con imágenes locales, si el servicio pide memoria, apaga el motor o la voz."}</p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-fg">{status === "failed" ? "El último intento falló" : "Crear video de imágenes"}</span>
            <span className="block text-[11px] text-muted">{status === "failed" ? song.videoError : `Guion visual con Ollama en el estilo del artista, una imagen por sección con el mismo personaje, movimiento de cámara y cortes al compás · ~${minutes} min${cost}`}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {providerSelect}
            {!song.instrumental && (
              <label className="flex items-center gap-1 text-[11px] text-muted" title="Letra sincronizada con la voz, resaltada palabra a palabra"><input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} className="h-4 w-4 accent-[var(--accent-2)]" />con letra</label>
            )}
            <button onClick={start} disabled={busy} className="rounded-md border border-accent-2/60 px-2.5 py-1 text-[11px] text-fg hover:bg-accent-2/20 disabled:opacity-40">{busy ? "Escribiendo guion…" : status === "failed" ? "Reintentar" : "Crear video"}</button>
          </span>
        </div>
      )}
      {err && <p className="mt-1 text-red-300">{err}</p>}
    </div>
  );
}
