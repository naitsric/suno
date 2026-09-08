import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { albums, artists, songs, voices, type Album, type Artist } from "@/db/schema";

export type ArtistSummary = Artist & { songCount: number; albumCount: number; voiceCount: number };

export function listArtists(): ArtistSummary[] {
  const rows = db.select().from(artists).orderBy(asc(artists.createdAt)).all();
  const songCounts = new Map(db.select({ id: songs.artistId, n: sql<number>`count(*)` }).from(songs).groupBy(songs.artistId).all().map((r) => [r.id, r.n]));
  const albumCounts = new Map(db.select({ id: albums.artistId, n: sql<number>`count(*)` }).from(albums).groupBy(albums.artistId).all().map((r) => [r.id, r.n]));
  const voiceCounts = new Map(db.select({ id: voices.artistId, n: sql<number>`count(*)` }).from(voices).groupBy(voices.artistId).all().map((r) => [r.id, r.n]));
  return rows.map((a) => ({ ...a, songCount: songCounts.get(a.id) ?? 0, albumCount: albumCounts.get(a.id) ?? 0, voiceCount: voiceCounts.get(a.id) ?? 0 }));
}

export function getArtist(id: string): Artist | undefined {
  return db.select().from(artists).where(eq(artists.id, id)).get();
}

export function createArtist(input: { name: string; emoji?: string; style?: string; description?: string; vocalLanguage?: string }): Artist {
  const row: Artist = {
    id: randomUUID(),
    name: input.name.trim() || "Artista",
    emoji: input.emoji?.trim() || "🎤",
    style: input.style?.trim() ?? "",
    description: input.description?.trim() ?? "",
    vocalLanguage: input.vocalLanguage ?? "es",
    defaultVoiceId: null,
    createdAt: Date.now(),
  };
  db.insert(artists).values(row).run();
  return row;
}

export function updateArtist(id: string, patch: Partial<Pick<Artist, "name" | "emoji" | "style" | "description" | "vocalLanguage" | "defaultVoiceId">>): Artist {
  const current = getArtist(id);
  if (!current) throw new Error("El artista no existe");
  if (patch.defaultVoiceId) {
    const v = db.select().from(voices).where(and(eq(voices.id, patch.defaultVoiceId), eq(voices.artistId, id))).get();
    if (!v) throw new Error("Esa voz no pertenece al artista");
  }
  db.update(artists).set(patch).where(eq(artists.id, id)).run();
  return getArtist(id)!;
}

/** Deletes the artist and its albums; songs and voices are kept but detached. */
export function deleteArtist(id: string) {
  if (!getArtist(id)) return false;
  db.update(songs).set({ artistId: null, albumId: null }).where(eq(songs.artistId, id)).run();
  db.update(voices).set({ artistId: null }).where(eq(voices.artistId, id)).run();
  db.delete(albums).where(eq(albums.artistId, id)).run();
  db.delete(artists).where(eq(artists.id, id)).run();
  return true;
}

export function listAlbums(artistId?: string): Album[] {
  const q = db.select().from(albums);
  return (artistId ? q.where(eq(albums.artistId, artistId)) : q).orderBy(desc(albums.createdAt)).all();
}

export function getAlbum(id: string): Album | undefined {
  return db.select().from(albums).where(eq(albums.id, id)).get();
}

export function createAlbum(artistId: string, name: string): Album {
  if (!getArtist(artistId)) throw new Error("El artista no existe");
  const row: Album = { id: randomUUID(), artistId, name: name.trim() || "Álbum", createdAt: Date.now() };
  db.insert(albums).values(row).run();
  return row;
}

export function renameAlbum(id: string, name: string): Album {
  if (!getAlbum(id)) throw new Error("El álbum no existe");
  db.update(albums).set({ name: name.trim() || "Álbum" }).where(eq(albums.id, id)).run();
  return getAlbum(id)!;
}

/** Deletes the album; its songs stay with the artist without album. */
export function deleteAlbum(id: string) {
  if (!getAlbum(id)) return false;
  db.update(songs).set({ albumId: null }).where(eq(songs.albumId, id)).run();
  db.delete(albums).where(eq(albums.id, id)).run();
  return true;
}

/** Moves a song to an artist/album (album must belong to the artist). */
export function assignSong(songId: string, artistId: string | null, albumId: string | null) {
  if (artistId && !getArtist(artistId)) throw new Error("El artista no existe");
  if (albumId) {
    const a = getAlbum(albumId);
    if (!a) throw new Error("El álbum no existe");
    if (a.artistId !== artistId) throw new Error("El álbum pertenece a otro artista");
  }
  db.update(songs).set({ artistId, albumId, updatedAt: Date.now() }).where(eq(songs.id, songId)).run();
}

export function unassignedSongCount(): number {
  return db.select({ n: sql<number>`count(*)` }).from(songs).where(isNull(songs.artistId)).get()?.n ?? 0;
}
