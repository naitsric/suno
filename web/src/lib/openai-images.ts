/** OpenAI image generation (gpt-image-1) for artist portraits and album covers. Key: OPENAI_API_KEY. */

export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

const MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2"; // "ChatGPT Imágenes 2.0"; gpt-image-1 and chatgpt-image-latest also work

export function openaiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function parseError(status: number, text: string): Error {
  let msg = text.slice(0, 300);
  try {
    msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
  } catch {
    /* raw text */
  }
  return new Error(`OpenAI respondió ${status}: ${msg}`);
}

/**
 * Generates an image that keeps the character/style of the reference PNGs (gpt-image-1 edits endpoint):
 * this is what keeps the same protagonist across the scenes of a video. Same cost as a generation.
 */
export async function generateImageWithReference(prompt: string, references: Buffer[], opts: { size?: ImageSize; quality?: ImageQuality } = {}): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY: añádela a web/.env.local y reinicia la web (pnpm dev).");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", opts.size ?? "1536x1024");
  form.append("quality", opts.quality ?? "medium");
  references.slice(0, 4).forEach((buf, i) => form.append("image[]", new Blob([new Uint8Array(buf)], { type: "image/png" }), `reference_${i + 1}.png`));
  const res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw parseError(res.status, await res.text());
  const body = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI no devolvió imagen");
  return Buffer.from(b64, "base64");
}

/** Returns the PNG bytes. Roughly 0.01 / 0.04 / 0.17 USD per 1024² image at low / medium / high. */
export async function generateImage(prompt: string, opts: { size?: ImageSize; quality?: ImageQuality } = {}): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY: añádela a web/.env.local y reinicia la web (pnpm dev).");
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, prompt, n: 1, size: opts.size ?? "1024x1024", quality: opts.quality ?? "medium", output_format: "png" }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* raw text */
    }
    throw new Error(`OpenAI respondió ${res.status}: ${msg}`);
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI no devolvió imagen");
  return Buffer.from(b64, "base64");
}
