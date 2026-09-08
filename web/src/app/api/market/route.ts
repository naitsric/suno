import { NextResponse } from "next/server";
import { COUNTRIES, getMarketSnapshot } from "@/lib/market";

export const dynamic = "force-dynamic";

/** `?country=co&refresh=1` */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const country = (url.searchParams.get("country") ?? "co").toLowerCase();
  if (!COUNTRIES.some((c) => c.code === country)) return NextResponse.json({ error: "País no soportado" }, { status: 400 });
  try {
    const snapshot = await getMarketSnapshot(country, url.searchParams.has("refresh"));
    // Keep the payload small for the UI: top 100 tracks without previews is fine.
    return NextResponse.json({ snapshot, countries: COUNTRIES });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo obtener el mercado" }, { status: 502 });
  }
}
