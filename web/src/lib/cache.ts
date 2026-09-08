import { eq } from "drizzle-orm";
import { db } from "@/db";
import { kvCache } from "@/db/schema";

export function cacheGet<T>(key: string, maxAgeMs: number): { value: T; createdAt: number } | null {
  const row = db.select().from(kvCache).where(eq(kvCache.key, key)).get();
  if (!row || Date.now() - row.createdAt > maxAgeMs) return null;
  try {
    return { value: JSON.parse(row.value) as T, createdAt: row.createdAt };
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, value: T) {
  const createdAt = Date.now();
  db.insert(kvCache).values({ key, value: JSON.stringify(value), createdAt }).onConflictDoUpdate({ target: kvCache.key, set: { value: JSON.stringify(value), createdAt } }).run();
  return createdAt;
}
