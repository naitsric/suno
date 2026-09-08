/**
 * Market snapshot from public chart endpoints (no API keys):
 *  - Deezer chart (localised to this machine's country) with album genres and release dates.
 *  - Apple Music RSS "most played" per country, with genres per song.
 * The snapshot is cached for 12 h; analysis/ideas are produced by the local LLM (Ollama).
 */
import { cacheGet, cacheSet } from "./cache";

export const COUNTRIES: { code: string; label: string }[] = [
  { code: "co", label: "Colombia" },
  { code: "mx", label: "México" },
  { code: "es", label: "España" },
  { code: "ar", label: "Argentina" },
  { code: "cl", label: "Chile" },
  { code: "pe", label: "Perú" },
  { code: "us", label: "Estados Unidos" },
  { code: "br", label: "Brasil" },
];

export type ChartTrack = { rank: number; title: string; artist: string; genres: string[]; releaseDate: string | null; durationSec: number | null; explicit: boolean | null; source: "deezer" | "apple"; url: string | null; preview: string | null };
export type GenreStat = { genre: string; count: number; weight: number; share: number; topArtists: string[]; examples: string[]; freshShare: number };

export type MarketSnapshot = {
  country: string;
  fetchedAt: number;
  sources: { deezer: boolean; apple: boolean; notes: string[] };
  tracks: ChartTrack[];
  genres: GenreStat[];
  topArtists: { name: string; count: number; bestRank: number }[];
  freshShare: number; // share of top tracks released in the last 90 days
  avgDurationSec: number | null;
  explicitShare: number | null;
  genreCharts: { genre: string; tracks: { title: string; artist: string }[] }[];
};

const SNAPSHOT_TTL = 12 * 60 * 60 * 1000;
const DEEZER = "https://api.deezer.com";
const GENRE_CHARTS: { id: number; genre: string }[] = [
  { id: 132, genre: "Pop" },
  { id: 122, genre: "Reggaetón" },
  { id: 116, genre: "Rap/Hip Hop" },
  { id: 152, genre: "Rock" },
  { id: 466, genre: "Folk" },
  { id: 65, genre: "Música Mexicana" },
  { id: 197, genre: "Latino" },
  { id: 113, genre: "Dance" },
];

async function getJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "SunoLocal/1.0" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

type DeezerTrack = { id: number; title: string; duration: number; explicit_lyrics: boolean; position: number; link: string; preview: string; artist: { name: string }; album: { id: number } };

async function fetchDeezer(notes: string[]): Promise<ChartTrack[]> {
  try {
    const chart = await getJson<{ data: DeezerTrack[] }>(`${DEEZER}/chart/0/tracks?limit=100`);
    const albumGenres = new Map<number, string[]>();
    const uniqueAlbums = [...new Set(chart.data.map((t) => t.album.id))];
    await mapLimit(uniqueAlbums, 4, async (id) => {
      try {
        const a = await getJson<{ genres?: { data?: { name: string }[] } }>(`${DEEZER}/album/${id}`);
        albumGenres.set(id, (a.genres?.data ?? []).map((g) => g.name));
      } catch {
        albumGenres.set(id, []);
      }
    });
    const releases = await mapLimit(chart.data, 4, async (t) => {
      try {
        const d = await getJson<{ release_date?: string }>(`${DEEZER}/track/${t.id}`);
        return d.release_date ?? null;
      } catch {
        return null;
      }
    });
    return chart.data.map((t, i) => ({
      rank: t.position ?? i + 1,
      title: t.title,
      artist: t.artist.name,
      genres: albumGenres.get(t.album.id) ?? [],
      releaseDate: releases[i],
      durationSec: t.duration ?? null,
      explicit: t.explicit_lyrics ?? null,
      source: "deezer" as const,
      url: t.link ?? null,
      preview: t.preview ?? null,
    }));
  } catch (err) {
    notes.push(`Deezer no disponible: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

type AppleSong = { name: string; artistName: string; genres?: { name: string }[]; releaseDate?: string; url?: string };

async function fetchApple(country: string, notes: string[]): Promise<ChartTrack[]> {
  try {
    const feed = await getJson<{ feed: { results: AppleSong[] } }>(`https://rss.applemarketingtools.com/api/v2/${country}/music/most-played/100/songs.json`);
    return feed.feed.results.map((s, i) => ({
      rank: i + 1,
      title: s.name,
      artist: s.artistName,
      genres: (s.genres ?? []).map((g) => g.name).filter((g) => g !== "Music" && g !== "Música"),
      releaseDate: s.releaseDate ?? null,
      durationSec: null,
      explicit: null,
      source: "apple" as const,
      url: s.url ?? null,
      preview: null,
    }));
  } catch (err) {
    notes.push(`Apple Music (${country}) no disponible: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchGenreCharts(): Promise<MarketSnapshot["genreCharts"]> {
  return mapLimit(GENRE_CHARTS, 3, async (g) => {
    try {
      const c = await getJson<{ data: DeezerTrack[] }>(`${DEEZER}/chart/${g.id}/tracks?limit=8`);
      return { genre: g.genre, tracks: c.data.map((t) => ({ title: t.title, artist: t.artist.name })) };
    } catch {
      return { genre: g.genre, tracks: [] };
    }
  });
}

const UMBRELLA = new Set(["Música", "Music", "Música latina", "Latin", "Latino", "Latin Music", "Pop latino", "Sin género"]);

const ALIASES: Record<string, string> = { "Hip-Hop/Rap": "Rap/Hip Hop", "Hip Hop/Rap": "Rap/Hip Hop", "Hip-Hop": "Rap/Hip Hop", "Reggaeton": "Reggaetón", "Urbano latino": "Reggaetón", "Electrónica": "Electro", "Electronic": "Electro", "Alternative": "Alternativo", "Latin": "Música latina", "Latin Music": "Música latina" };

/** Unifies Apple/Deezer labels and drops umbrella labels when a finer genre exists. */
function cleanGenres(genres: string[]): string[] {
  const uniq = [...new Set(genres.filter(Boolean).map((g) => ALIASES[g] ?? g))];
  const fine = uniq.filter((g) => !UMBRELLA.has(g));
  return fine.length ? fine : uniq;
}

/** Looks a song up on Deezer to borrow its album genres, duration and preview. */
async function enrichFromDeezerSearch(t: ChartTrack, albumGenres: Map<number, string[]>): Promise<void> {
  try {
    const q = encodeURIComponent(`${t.title.replace(/\(.*?\)/g, "")} ${t.artist.split(/,|&|feat\.?/i)[0]}`.trim());
    const r = await getJson<{ data: DeezerTrack[] }>(`${DEEZER}/search?q=${q}&limit=1`);
    const m = r.data[0];
    if (!m) return;
    if (!albumGenres.has(m.album.id)) {
      const a = await getJson<{ genres?: { data?: { name: string }[] } }>(`${DEEZER}/album/${m.album.id}`);
      albumGenres.set(m.album.id, (a.genres?.data ?? []).map((g) => g.name));
    }
    const genres = albumGenres.get(m.album.id) ?? [];
    if (genres.length) t.genres = cleanGenres([...genres, ...t.genres]);
    t.durationSec = t.durationSec ?? m.duration ?? null;
    t.explicit = t.explicit ?? m.explicit_lyrics ?? null;
    t.preview = t.preview ?? m.preview ?? null;
  } catch {
    /* keep Apple data */
  }
}

const FRESH_DAYS = 90;

function isFresh(date: string | null) {
  if (!date) return false;
  const t = Date.parse(date);
  return Number.isFinite(t) && Date.now() - t < FRESH_DAYS * 86_400_000;
}

function summarize(tracks: ChartTrack[]): Pick<MarketSnapshot, "genres" | "topArtists" | "freshShare" | "avgDurationSec" | "explicitShare"> {
  type GenreAcc = { count: number; weight: number; artists: Map<string, number>; examples: string[]; fresh: number };
  const byGenre = new Map<string, GenreAcc>();
  for (const t of tracks) {
    const w = 1 / Math.sqrt(t.rank); // higher positions weigh more
    for (const g of t.genres.length ? t.genres : ["Sin género"]) {
      const e: GenreAcc = byGenre.get(g) ?? { count: 0, weight: 0, artists: new Map<string, number>(), examples: [], fresh: 0 };
      e.count += 1;
      e.weight += w;
      e.artists.set(t.artist, (e.artists.get(t.artist) ?? 0) + 1);
      if (e.examples.length < 3) e.examples.push(`${t.title} – ${t.artist}`);
      if (isFresh(t.releaseDate)) e.fresh += 1;
      byGenre.set(g, e);
    }
  }
  const totalWeight = [...byGenre.values()].reduce((a, e) => a + e.weight, 0) || 1;
  const genres = [...byGenre.entries()]
    .map(([genre, e]) => ({ genre, count: e.count, weight: e.weight, share: e.weight / totalWeight, topArtists: [...e.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n), examples: e.examples, freshShare: e.count ? e.fresh / e.count : 0 }))
    .sort((a, b) => b.weight - a.weight);

  const artists = new Map<string, { count: number; bestRank: number }>();
  for (const t of tracks) {
    const a = artists.get(t.artist) ?? { count: 0, bestRank: 999 };
    a.count += 1;
    a.bestRank = Math.min(a.bestRank, t.rank);
    artists.set(t.artist, a);
  }
  const topArtists = [...artists.entries()].map(([name, a]) => ({ name, ...a })).sort((a, b) => b.count - a.count || a.bestRank - b.bestRank).slice(0, 12);
  const withDate = tracks.filter((t) => t.releaseDate);
  const durations = tracks.map((t) => t.durationSec).filter((d): d is number => !!d);
  const explicit = tracks.map((t) => t.explicit).filter((e): e is boolean => e !== null);
  return {
    genres,
    topArtists,
    freshShare: withDate.length ? withDate.filter((t) => isFresh(t.releaseDate)).length / withDate.length : 0,
    avgDurationSec: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    explicitShare: explicit.length ? explicit.filter(Boolean).length / explicit.length : null,
  };
}

export async function getMarketSnapshot(country: string, refresh = false): Promise<MarketSnapshot> {
  const key = `market:${country}`;
  if (!refresh) {
    const hit = cacheGet<MarketSnapshot>(key, SNAPSHOT_TTL);
    if (hit) return hit.value;
  }
  const notes: string[] = [];
  const [apple, deezer, genreCharts] = await Promise.all([fetchApple(country, notes), country === "co" ? fetchDeezer(notes) : Promise.resolve([] as ChartTrack[]), fetchGenreCharts()]);
  // Apple gives the country ranking but coarse genres ("Música latina"); Deezer has album-level genres.
  const tracks = apple.length ? apple : deezer;
  if (tracks.length === 0) throw new Error(`Sin datos de mercado. ${notes.join(" ")}`);
  if (apple.length) {
    const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|feat\..*|[^a-z0-9áéíóúñü ]/g, "").trim();
    const dz = new Map(deezer.map((t) => [`${norm(t.title)}|${norm(t.artist.split(/,|&/)[0])}`, t]));
    const albumGenres = new Map<number, string[]>();
    const pending: ChartTrack[] = [];
    for (const t of tracks) {
      const m = dz.get(`${norm(t.title)}|${norm(t.artist.split(/,|&/)[0])}`);
      if (m) {
        t.durationSec = m.durationSec;
        t.explicit = m.explicit;
        t.preview = m.preview;
        t.genres = cleanGenres([...m.genres, ...t.genres]);
      } else {
        pending.push(t);
      }
    }
    await mapLimit(pending, 4, (t) => enrichFromDeezerSearch(t, albumGenres));
    for (const t of tracks) t.genres = cleanGenres(t.genres);
  } else {
    for (const t of tracks) t.genres = cleanGenres(t.genres);
  }
  const snapshot: MarketSnapshot = {
    country,
    fetchedAt: Date.now(),
    sources: { deezer: deezer.length > 0, apple: apple.length > 0, notes },
    tracks,
    ...summarize(tracks),
    genreCharts,
  };
  cacheSet(key, snapshot);
  return snapshot;
}

/** Compact text version of the snapshot for the LLM prompt. */
export function snapshotForPrompt(s: MarketSnapshot): string {
  const lines = [
    `País: ${COUNTRIES.find((c) => c.code === s.country)?.label ?? s.country}. Fuentes: ${[s.sources.apple ? "Apple Music top 100" : null, s.sources.deezer ? "Deezer top 100" : null].filter(Boolean).join(" + ")}.`,
    `Lanzamientos de los últimos ${FRESH_DAYS} días en el top: ${Math.round(s.freshShare * 100)}%. Duración media: ${s.avgDurationSec ? `${Math.round(s.avgDurationSec)} s` : "n/d"}. Explícitas: ${s.explicitShare !== null ? `${Math.round(s.explicitShare * 100)}%` : "n/d"}.`,
    "Géneros por peso en el top (peso da más valor a las posiciones altas):",
    ...s.genres.slice(0, 14).map((g) => `- ${g.genre}: ${Math.round(g.share * 100)}% (${g.count} canciones, ${Math.round(g.freshShare * 100)}% recientes). Artistas: ${g.topArtists.join(", ")}. Ej: ${g.examples.join("; ")}`),
    `Artistas con más canciones en el top: ${s.topArtists.slice(0, 10).map((a) => `${a.name} (${a.count}, mejor #${a.bestRank})`).join(", ")}.`,
    "Top 20:",
    ...s.tracks.slice(0, 20).map((t) => `${t.rank}. ${t.title} – ${t.artist} [${t.genres.join("/") || "?"}]${t.releaseDate ? ` (${t.releaseDate})` : ""}`),
    "Top por género (Deezer):",
    ...s.genreCharts.filter((g) => g.tracks.length).map((g) => `- ${g.genre}: ${g.tracks.slice(0, 5).map((t) => `${t.title} – ${t.artist}`).join("; ")}`),
  ];
  return lines.join("\n");
}
