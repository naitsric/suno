"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ArtistProfile from "./ArtistProfile";
import ArtistRail from "./ArtistRail";
import CreatePanel from "./CreatePanel";
import Library from "./Library";
import MarketPanel from "./MarketPanel";
import Player from "./Player";
import VoicePanel from "./VoicePanel";
import type { AlbumDTO, ArtistDTO, CreateDraft, EngineStatus, Scope, SongDTO, VoiceDTO } from "@/lib/types";
import type { MarketIdea } from "@/lib/market-ideas";

const SCOPE_KEY = "suno-local:scope";

function scopeQuery(scope: Scope) {
  if (scope.kind === "all" || scope.kind === "market") return "";
  return `?artist=${scope.kind === "none" ? "none" : scope.id}`;
}

export default function Studio() {
  const [songs, setSongs] = useState<SongDTO[]>([]);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [current, setCurrent] = useState<SongDTO | null>(null);
  const [voices, setVoices] = useState<VoiceDTO[]>([]);
  const [artists, setArtists] = useState<ArtistDTO[]>([]);
  const [albums, setAlbums] = useState<AlbumDTO[]>([]);
  const [unassigned, setUnassigned] = useState(0);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [tab, setTab] = useState<"create" | "voice">("create");
  const [error, setError] = useState<string | null>(null);
  const [playerTime, setPlayerTime] = useState(0);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [lastArtistId, setLastArtistId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const scopeRef = useRef(scope);

  const artist = scope.kind === "artist" ? artists.find((a) => a.id === scope.id) ?? null : null;
  const scopedVoices = artist ? voices.filter((v) => v.artistId === artist.id) : voices.filter((v) => !v.artistId);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/songs${scopeQuery(scopeRef.current)}`, { cache: "no-store" });
      setSongs(((await res.json()) as { songs: SongDTO[] }).songs);
    } catch {
      /* keep last state */
    }
  }, []);

  const refreshArtists = useCallback(async () => {
    try {
      const res = await fetch("/api/artists", { cache: "no-store" });
      const body = (await res.json()) as { artists: ArtistDTO[]; albums: AlbumDTO[]; unassignedSongs: number };
      setArtists(body.artists);
      setAlbums(body.albums);
      setUnassigned(body.unassignedSongs);
    } catch {
      /* keep last state */
    }
  }, []);

  const refreshVoices = useCallback(async () => {
    try {
      const res = await fetch("/api/voices", { cache: "no-store" });
      setVoices(((await res.json()) as { voices: VoiceDTO[] }).voices);
    } catch {
      /* keep last state */
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      setStatus((await res.json()) as EngineStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  // Initial load: restore the last selected scope, then fetch everything.
  useEffect(() => {
    const first = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(SCOPE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Scope;
          scopeRef.current = parsed;
          setScope(parsed);
          if (parsed.kind === "artist") setLastArtistId(parsed.id);
        }
      } catch {
        /* ignore */
      }
      refresh();
      refreshStatus();
      refreshVoices();
      refreshArtists();
    }, 0);
    const t = window.setInterval(refreshStatus, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh, refreshStatus, refreshVoices, refreshArtists]);

  const selectScope = (s: Scope, keepDraft = false) => {
    scopeRef.current = s;
    setScope(s);
    setTab("create");
    if (!keepDraft) setDraft(null);
    if (s.kind === "artist") setLastArtistId(s.id);
    try {
      window.localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
    refresh();
  };

  // Poll faster while something is generating.
  const busy = songs.some((s) => s.status === "queued" || s.status === "generating" || s.status === "converting");
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(refresh, busy ? 3_000 : 20_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [busy, refresh]);

  const onCreated = (created: SongDTO[]) => {
    setSongs((prev) => [...created, ...prev]);
    setError(null);
    refreshArtists();
  };

  const onDelete = async (id: string) => {
    await fetch(`/api/songs/${id}`, { method: "DELETE" });
    setSongs((prev) => prev.filter((s) => s.id !== id));
    if (current?.id === id) setCurrent(null);
    refreshArtists();
  };

  const onSongUpdated = (u: SongDTO) => {
    const stillVisible = scope.kind === "all" || scope.kind === "market" || (scope.kind === "none" ? !u.artistId : u.artistId === scope.id);
    setSongs((prev) => (stillVisible ? prev.map((s) => (s.id === u.id ? u : s)) : prev.filter((s) => s.id !== u.id)));
    refreshArtists();
  };

  /** "Crear" on a genre suggested for a voice: prefill the create panel with that style and jump to it. */
  const useVoiceStyle = (style: string, genre: string, brief: string) => {
    // The description seeds the lyric writer, so it describes the song (sound + a theme to fill in), not the voice.
    const description = `${brief}. Trata sobre `;
    setDraft({ nonce: Date.now(), mode: "simple", style, description, label: `Estilo sugerido para tu voz: ${genre}`, artistId: artist?.id ?? null });
    setTab("create");
  };

  const useIdea = (idea: MarketIdea, artistId: string | null) => {
    const target = artistId ?? lastArtistId ?? artists[0]?.id ?? null;
    selectScope(target ? { kind: "artist", id: target } : { kind: "all" }, true);
    setDraft({
      nonce: Date.now(),
      mode: "simple",
      title: idea.title,
      style: idea.style,
      description: [idea.theme, idea.hook ? `Estribillo sugerido: “${idea.hook}”` : "", `Género: ${idea.genre}.`].filter(Boolean).join(" "),
      artistId: target,
    });
  };

  const playable = songs.filter((s) => s.status === "done");
  const playNext = (dir: 1 | -1) => {
    if (!current) return;
    const idx = playable.findIndex((s) => s.id === current.id);
    const next = playable[idx + dir];
    if (next) setCurrent(next);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <span className="inline-block h-8 w-8 rounded-lg" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }} />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Suno Local</h1>
            <p className="text-xs text-muted">Música generada 100% en tu Mac · ACE-Step 1.5</p>
          </div>
        </div>
        <StatusPills status={status} />
      </header>

      {error && (
        <div className="mx-6 mt-4 flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-sm">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-muted hover:text-fg">✕</button>
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[220px_400px_1fr] gap-0 pb-28">
        <div className="border-b lg:border-b-0 lg:border-r border-border lg:h-[calc(100vh-65px-7rem)] overflow-y-auto">
          <ArtistRail artists={artists} scope={scope} unassigned={unassigned} onSelect={selectScope} onCreated={(a) => { setArtists((prev) => [...prev, a]); selectScope({ kind: "artist", id: a.id }); setTab("voice"); }} onError={setError} />
        </div>

        <aside className="border-b lg:border-b-0 lg:border-r border-border p-5 overflow-y-auto lg:h-[calc(100vh-65px-7rem)]">
          <div className="mb-4 flex gap-4 border-b border-border text-sm">
            {([["create", "Crear"], ["voice", artist ? `Perfil · ${artist.name}` : `Mi voz${scopedVoices.length ? ` · ${scopedVoices.length}` : ""}`]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 pb-2 transition ${tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === "create" ? (
            <CreatePanel status={status} voices={scopedVoices} artist={artist} albums={albums.filter((a) => a.artistId === artist?.id)} draft={draft} onCreated={onCreated} onError={setError} onGoToVoices={() => setTab("voice")} onClearDraft={() => setDraft(null)} />
          ) : artist ? (
            <ArtistProfile
              artist={artist}
              voices={scopedVoices}
              onUpdated={(a) => setArtists((prev) => prev.map((x) => (x.id === a.id ? a : x)))}
              onDeleted={() => { selectScope({ kind: "all" }); refreshArtists(); refreshVoices(); }}
              onVoicesChanged={() => { refreshVoices(); refreshArtists(); }}
              onError={setError}
              onUseStyle={useVoiceStyle}
            />
          ) : (
            <VoicePanel voices={scopedVoices} artists={artists} onChange={() => { refreshVoices(); refreshArtists(); }} onError={setError} onUseStyle={useVoiceStyle} />
          )}
        </aside>

        <section className="p-5 overflow-y-auto overflow-x-hidden lg:h-[calc(100vh-65px-7rem)]">
          {scope.kind === "market" ? (
            <MarketPanel artists={artists} defaultArtistId={lastArtistId ?? artists[0]?.id ?? null} onUseIdea={useIdea} onError={setError} />
          ) : (
          <Library songs={songs} current={current} artist={artist} artists={artists} voices={voices} onVoicesChanged={() => { refreshVoices(); refreshArtists(); }} albums={albums} playerTime={current ? playerTime : null} onPlay={setCurrent} onDelete={onDelete} onUpdated={onSongUpdated} onCreated={onCreated} onAlbumsChanged={refreshArtists} onError={setError} />
          )}
        </section>
      </main>

      <Player song={current} onEnded={() => playNext(1)} onPrev={() => playNext(-1)} onNext={() => playNext(1)} onTime={setPlayerTime} />
    </div>
  );
}

function StatusPills({ status }: { status: EngineStatus | null }) {
  const pill = (ok: boolean, label: string, title?: string) => (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${ok ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
      {label}
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      {pill(!!status?.engine.online, status?.engine.online ? `Motor · ${status.engine.defaultModel ?? "ACE-Step"}` : "Motor apagado", "ACE-Step API en :8001 (make engine)")}
      {pill(!!status?.ollama.online, status?.ollama.online ? `Letras · ${status.ollama.model ?? "Ollama"}` : "Letras · Ollama apagado", "Ollama para escribir letras en modo simple")}
      {pill(!!status?.voice.online, status?.voice.online ? "Voz · listo" : "Voz · apagado", "Servicio de conversión de voz y realce en :8002 (make voice)")}
    </div>
  );
}
