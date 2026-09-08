"use client";

import { useCallback, useEffect, useState } from "react";
import type { ArtistDTO } from "@/lib/types";
import type { MarketSnapshot } from "@/lib/market";
import type { MarketAnalysis, MarketIdea } from "@/lib/market-ideas";

type Country = { code: string; label: string };

export default function MarketPanel({ artists, defaultArtistId, onUseIdea, onError }: { artists: ArtistDTO[]; defaultArtistId: string | null; onUseIdea: (idea: MarketIdea, artistId: string | null) => void; onError: (e: string | null) => void }) {
  const [country, setCountry] = useState("co");
  const [countries, setCountries] = useState<Country[]>([{ code: "co", label: "Colombia" }]);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [artistId, setArtistId] = useState<string>(defaultArtistId ?? "");
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async (c: string, refresh = false) => {
    setLoading(true);
    onError(null);
    try {
      const res = await fetch(`/api/market?country=${c}${refresh ? "&refresh=1" : ""}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo cargar el mercado");
      setSnapshot(body.snapshot as MarketSnapshot);
      setCountries(body.countries as Country[]);
      setAnalysis(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    const id = window.setTimeout(() => load(country), 0);
    return () => window.clearTimeout(id);
  }, [country, load]);

  const analyze = async (refresh = false) => {
    setAnalyzing(true);
    onError(null);
    try {
      const res = await fetch("/api/market/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ country, artistId: artistId || null, refresh }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo analizar");
      setAnalysis(body.analysis as MarketAnalysis);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const ask = async () => {
    if (question.trim().length < 3) return;
    setAsking(true);
    onError(null);
    try {
      const res = await fetch("/api/market/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ country, artistId: artistId || null, question }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo responder");
      setAnswer(body.answer as string);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };

  const artist = artists.find((a) => a.id === artistId) ?? null;
  const maxShare = snapshot?.genres[0]?.share ?? 1;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-medium uppercase tracking-wide text-muted">📈 Mercado</h2>
        <select value={country} onChange={(e) => setCountry(e.target.value)} className={selectCls}>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>
        <button onClick={() => load(country, true)} disabled={loading} className="rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-fg disabled:opacity-40">{loading ? "Cargando…" : "Actualizar"}</button>
        {snapshot && (
          <span className="text-[11px] text-muted">
            {[snapshot.sources.apple ? "Apple Music top 100" : null, snapshot.sources.deezer ? "Deezer top 100" : null].filter(Boolean).join(" + ")} · {new Date(snapshot.fetchedAt).toLocaleString()}
          </span>
        )}
      </div>

      {snapshot && (
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <section className="rounded-xl border border-border bg-panel p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Géneros en el top 100</h3>
              <span className="text-[11px] text-muted">peso por posición · % recientes (90 días)</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {snapshot.genres.slice(0, 12).map((g) => (
                <li key={g.genre} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{g.genre}</span>
                    <span className="shrink-0 text-muted">{Math.round(g.share * 100)}% · {g.count} · <span className={g.freshShare >= 0.4 ? "text-emerald-300" : ""}>{Math.round(g.freshShare * 100)}% nuevas</span></span>
                  </div>
                  <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-panel-2">
                    <div className="h-full rounded" style={{ width: `${(g.share / maxShare) * 100}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }} />
                  </div>
                  <div className="truncate text-[11px] text-muted/80">{g.topArtists.join(" · ")}</div>
                </li>
              ))}
            </ul>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <Stat label="Lanzamientos recientes" value={`${Math.round(snapshot.freshShare * 100)}%`} />
              <Stat label="Duración media" value={snapshot.avgDurationSec ? `${Math.floor(snapshot.avgDurationSec / 60)}:${String(Math.round(snapshot.avgDurationSec % 60)).padStart(2, "0")}` : "n/d"} />
              <Stat label="Explícitas" value={snapshot.explicitShare !== null ? `${Math.round(snapshot.explicitShare * 100)}%` : "n/d"} />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-panel p-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Top 20 · {countries.find((c) => c.code === country)?.label}</h3>
            <ol className="flex flex-col gap-1 text-xs">
              {snapshot.tracks.slice(0, 20).map((t) => (
                <li key={`${t.rank}-${t.title}`} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right font-mono text-muted">{t.rank}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {t.url ? <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">{t.title}</a> : t.title}
                    <span className="text-muted"> · {t.artist}</span>
                  </span>
                  <span className="hidden shrink-0 text-[10px] text-muted md:inline">{t.genres.slice(0, 2).join("/")}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[11px] text-muted">Artistas con más canciones en el top: {snapshot.topArtists.slice(0, 8).map((a) => `${a.name} (${a.count})`).join(", ")}.</p>
          </section>
        </div>
      )}

      <section className="rounded-xl border border-accent-2/40 bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">💡 Ideas para crear</h3>
          <select value={artistId} onChange={(e) => { setArtistId(e.target.value); setAnalysis(null); }} className={selectCls}>
            <option value="">Sin perfil (ideas generales)</option>
            {artists.map((a) => (
              <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
            ))}
          </select>
          <button onClick={() => analyze(false)} disabled={analyzing || !snapshot} className="rounded-md bg-accent-2 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{analyzing ? "Analizando con Ollama… (3-5 min)" : analysis ? "Volver a analizar" : "Analizar mercado"}</button>
          {analysis && <button onClick={() => analyze(true)} disabled={analyzing} className="text-[11px] text-muted hover:text-fg">generar otras ideas</button>}
        </div>
        {!analysis && !analyzing && <p className="mt-2 text-xs text-muted">Ollama lee los datos de arriba{artist ? ` y el perfil de ${artist.name}` : ""} y propone qué música crear, con estilo listo para generar.</p>}

        {analysis && (
          <div className="mt-4 flex flex-col gap-4 text-sm">
            <p className="leading-relaxed text-fg/90">{analysis.overview}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Tendencias</p>
                <ul className="flex flex-col gap-1.5 text-xs">
                  {analysis.trends.map((t, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${SIGNAL_CLS[t.signal] ?? "bg-panel-2 text-muted"}`}>{t.signal}</span>
                      <span><span className="font-medium">{t.genre}</span> <span className="text-muted">· {t.why}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Huecos y oportunidades</p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-fg/90">
                  {analysis.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Canciones propuestas{artist ? ` para ${artist.name}` : ""}</p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {analysis.ideas.map((idea, i) => (
                  <article key={i} className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel-2/60 p-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-medium text-fg">{idea.title}</h4>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${FIT_CLS[idea.fit]}`}>{FIT_LABEL[idea.fit]}</span>
                    </div>
                    <p className="text-muted">{idea.genre}</p>
                    <p className="text-fg/90">{idea.theme}</p>
                    {idea.hook && <p className="italic text-fg/80">“{idea.hook}”</p>}
                    <p className="text-[11px] text-muted">{idea.why}</p>
                    <p className="truncate font-mono text-[10px] text-muted/80" title={idea.style}>{idea.style}</p>
                    <button onClick={() => onUseIdea(idea, artistId || null)} className="mt-1 self-start rounded-md border border-accent-2/60 px-2.5 py-1 text-[11px] text-fg hover:bg-accent-2/20">Crear con esta idea →</button>
                  </article>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-muted">Generado por {analysis.model} · {new Date(analysis.generatedAt).toLocaleString()}. Interpretación de un modelo local: contrasta antes de apostar.</p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-panel p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Pregúntale al mercado</h3>
        <div className="flex gap-2">
          <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(); }} placeholder="¿Qué géneros están creciendo para un cantautor en español? ¿Qué duración funciona?" className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent-2" />
          <button onClick={ask} disabled={asking || !snapshot} className="rounded-lg border border-accent-2/60 px-3 py-2 text-xs text-fg hover:bg-accent-2/20 disabled:opacity-40">{asking ? "Pensando…" : "Preguntar"}</button>
        </div>
        {answer && <div className="mt-3 whitespace-pre-wrap rounded-lg bg-panel-2/60 p-3 text-sm leading-relaxed text-fg/90">{answer}</div>}
      </section>
    </div>
  );
}

const selectCls = "rounded-md border border-border bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent-2";
const SIGNAL_CLS: Record<string, string> = { dominante: "bg-accent/20 text-accent", creciendo: "bg-emerald-500/20 text-emerald-300", nicho: "bg-accent-2/20 text-accent-2", saturado: "bg-panel-2 text-muted" };
const FIT_CLS: Record<MarketIdea["fit"], string> = { alto: "bg-emerald-500/20 text-emerald-300", medio: "bg-accent-2/20 text-accent-2", apuesta: "bg-accent/20 text-accent" };
const FIT_LABEL: Record<MarketIdea["fit"], string> = { alto: "encaja", medio: "estira", apuesta: "apuesta" };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-panel-2/60 p-2">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}
