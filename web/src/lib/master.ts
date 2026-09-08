/**
 * Post-production ("mastering") with ffmpeg, in two passes:
 *   1. measure integrated loudness / true peak with `loudnorm`
 *   2. apply the preset's chain + linear loudnorm with the measured values + brickwall limiter
 *
 * Chains are deliberately conservative: generated music already has artefacts, and aggressive
 * processing makes them more audible rather than less.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

import type { MasterPreset } from "./master-presets";

export { MASTER_PRESETS, MASTER_LABELS, type MasterPreset } from "./master-presets";

type Chain = { filters: string[]; targetLufs: number; truePeak: number; lra: number };

const CHAINS: Record<Exclude<MasterPreset, "off">, Chain> = {
  // Cleans mud, removes faint diffusion hiss, adds presence and air. Streaming-standard loudness.
  clear: {
    filters: [
      "highpass=f=28:poles=2",
      "afftdn=nr=5:nf=-45:tn=1",
      "equalizer=f=220:t=q:w=1.3:g=-2",
      "equalizer=f=3200:t=q:w=1.1:g=1.5",
      "highshelf=f=9500:g=2",
      "deesser=i=0.15:m=0.4:f=0.4",
      "acompressor=threshold=-16dB:ratio=2.2:attack=20:release=150:knee=4:makeup=1.5",
    ],
    targetLufs: -14,
    truePeak: -1,
    lra: 9,
  },
  // Softer top end, fuller low-mids; good for acoustic, ballads, boleros.
  warm: {
    filters: [
      "highpass=f=25:poles=2",
      "afftdn=nr=4:nf=-45:tn=1",
      "lowshelf=f=140:g=1.5",
      "equalizer=f=400:t=q:w=1.2:g=-1",
      "equalizer=f=2800:t=q:w=1.0:g=0.8",
      "highshelf=f=12000:g=-1",
      "acompressor=threshold=-17dB:ratio=2:attack=25:release=200:knee=6:makeup=1.5",
    ],
    targetLufs: -14,
    truePeak: -1,
    lra: 10,
  },
  // Denser and louder (club/pop), still below the clipping point.
  loud: {
    filters: [
      "highpass=f=30:poles=2",
      "afftdn=nr=5:nf=-45:tn=1",
      "equalizer=f=250:t=q:w=1.2:g=-1.5",
      "equalizer=f=3500:t=q:w=1.0:g=2",
      "highshelf=f=10000:g=2.5",
      "acompressor=threshold=-20dB:ratio=3:attack=10:release=100:knee=3:makeup=3",
    ],
    targetLufs: -11,
    truePeak: -0.8,
    lra: 7,
  },
};

type Measured = { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };

function parseLoudnorm(stderr: string): Measured {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No se pudo medir el loudness");
  return JSON.parse(stderr.slice(start, end + 1)) as Measured;
}

export async function masterAudio(input: string, output: string, preset: MasterPreset): Promise<void> {
  if (preset === "off") {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-codec:a", "libmp3lame", "-b:a", "256k", output]);
    return;
  }
  const chain = CHAINS[preset];
  const base = chain.filters.join(",");
  const ln = `loudnorm=I=${chain.targetLufs}:TP=${chain.truePeak}:LRA=${chain.lra}`;

  // Pass 1: measure after the tonal chain so the gain math matches what pass 2 hears.
  const p1 = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-af", `${base},${ln}:print_format=json`, "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
  const m = parseLoudnorm(p1.stderr);

  // Pass 2: linear loudness normalisation (no dynamic pumping) + true-peak limiter.
  const ln2 = `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=none`;
  const limiter = `alimiter=limit=${Math.pow(10, chain.truePeak / 20).toFixed(3)}:attack=5:release=60:level=false`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-af", `${base},${ln2},${limiter}`, "-ar", "48000", "-codec:a", "libmp3lame", "-b:a", "256k", output]);
}
