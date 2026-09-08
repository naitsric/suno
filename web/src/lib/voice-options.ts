/**
 * Quality knobs of the voice conversion (`POST :8002/convert`). All optional: an absent knob keeps the
 * service default, which reproduces the historical pipeline. Stored per song as JSON (`songs.voice_options`)
 * so a re-conversion and the automatic conversion of a new song use the same settings.
 */
import { z } from "zod";

export const ConversionOptionsSchema = z
  .object({
    /** Seed-VC diffusion steps (service default 30; 50–60 = finer texture, ~1.7× slower). */
    diffusionSteps: z.number().int().min(5).max(100).optional(),
    /** Seed-VC classifier-free guidance (default 0.7; lower = less forced timbre, smoother). */
    cfgRate: z.number().min(0).max(1).optional(),
    /** Second Demucs pass + DeEcho over the reference before Seed-VC (less instrument bleed/room). */
    refDenoise: z.boolean().optional(),
    /** Seconds of reference used as the timbre prompt (5–30; Seed-VC caps at 25). */
    refSeconds: z.number().min(5).max(30).optional(),
    /** Max automatic EQ (dB) matching the converted vocal to the original stem's spectrum; 0 = off. */
    glueSpectrumDb: z.number().min(0).max(12).optional(),
    /** Synthetic reverb at the measured wet level of the original stem. */
    glueReverb: z.boolean().optional(),
    /** Apollo restoration over the converted vocal stem before mixing. */
    enhanceVocals: z.boolean().optional(),
    /** dB of attenuation of the non-harmonic (noisy) part of the converted stem above 2.5 kHz (HPSS); 0 = off. */
    deharshDb: z.number().min(0).max(12).optional(),
    /** Hybrid: converted vocal below this frequency, the original stem's highs above it (1000–12000; 0 = off). */
    keepHighsHz: z.number().min(0).max(12000).optional(),
  })
  .strict();

export type ConversionOptions = z.infer<typeof ConversionOptionsSchema>;

/** Parses the JSON stored in `songs.voice_options`; unknown/invalid content → {} (service defaults). */
export function parseConversionOptions(json: string | null | undefined): ConversionOptions {
  if (!json) return {};
  try {
    const parsed = ConversionOptionsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Multipart fields for `POST :8002/convert`; only the knobs that were set are sent. */
export function conversionFormFields(o: ConversionOptions): [string, string][] {
  const out: [string, string][] = [];
  if (o.diffusionSteps !== undefined) out.push(["diffusion_steps", String(o.diffusionSteps)]);
  if (o.cfgRate !== undefined) out.push(["cfg_rate", String(o.cfgRate)]);
  if (o.refDenoise !== undefined) out.push(["ref_denoise", String(o.refDenoise)]);
  if (o.refSeconds !== undefined) out.push(["ref_seconds", String(o.refSeconds)]);
  if (o.glueSpectrumDb !== undefined) out.push(["glue_spectrum_db", String(o.glueSpectrumDb)]);
  if (o.glueReverb !== undefined) out.push(["glue_reverb", String(o.glueReverb)]);
  if (o.enhanceVocals !== undefined) out.push(["enhance_vocals", String(o.enhanceVocals)]);
  if (o.deharshDb !== undefined) out.push(["deharsh_db", String(o.deharshDb)]);
  if (o.keepHighsHz !== undefined) out.push(["keep_highs_hz", String(o.keepHighsHz)]);
  return out;
}
