"use client";

import { useEffect, useRef, useState } from "react";
import { coverGradient, fmtTime, type SongDTO } from "@/lib/types";

export default function Player({ song, onEnded, onPrev, onNext, onTime }: { song: SongDTO | null; onEnded: () => void; onPrev: () => void; onNext: () => void; onTime?: (t: number) => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    const a = ref.current;
    if (!a || !song) return;
    a.src = `/api/songs/${song.id}/audio`;
    a.play().catch(() => setPlaying(false));
  }, [song]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play();
    else a.pause();
  };

  return (
    <footer className="fixed inset-x-0 bottom-0 border-t border-border bg-panel/95 backdrop-blur">
      <audio ref={ref} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => { setT(e.currentTarget.currentTime); onTime?.(e.currentTarget.currentTime); }} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} onEnded={onEnded} />
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <div className="h-12 w-12 shrink-0 rounded-md" style={{ background: song ? coverGradient(song.taskId ?? song.id) : "var(--panel-2)" }} />
        <div className="w-48 min-w-0">
          <p className="truncate text-sm font-medium">{song ? song.title : "Nada reproduciéndose"}</p>
          <p className="truncate text-xs text-muted">{song ? song.style.split(",").slice(0, 3).join(", ") : "Elige una canción de la biblioteca"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Btn onClick={onPrev} label="⏮" />
          <button onClick={toggle} disabled={!song} className="flex h-10 w-10 items-center justify-center rounded-full bg-fg text-bg disabled:opacity-40" aria-label={playing ? "Pausar" : "Reproducir"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <Btn onClick={onNext} label="⏭" />
        </div>
        <div className="flex flex-1 items-center gap-2 text-xs text-muted">
          <span className="w-10 text-right font-mono">{fmtTime(t)}</span>
          <input type="range" min={0} max={dur || 0} step={0.1} value={t} onChange={(e) => { if (ref.current) ref.current.currentTime = Number(e.target.value); }} className="flex-1 accent-[var(--accent)]" disabled={!song} />
          <span className="w-10 font-mono">{fmtTime(dur)}</span>
        </div>
        {song && (
          <>
            <a href={`/api/songs/${song.id}/audio?download`} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-fg">Descargar</a>
            <a href={`/api/songs/${song.id}/audio?format=wav`} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-fg" title="WAV 24 bits, 48 kHz">WAV</a>
          </>
        )}
      </div>
    </footer>
  );
}

function Btn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="rounded-md px-2 py-1 text-muted hover:text-fg" aria-label={label}>{label}</button>
  );
}
