"""Full-song Pixar music video: bar-aligned clips, shot/lighting driven by the song's energy, one reference image
for identity, resumable per clip. Runs on CUDA (cloud node) or MPS (Mac, slowly).

    full_video.py <song.mp3> --ref ref.png --name cenizas [--bpm 128] [--steps 30] [--plan-only] [--max-clips N]

Outputs under out/full/<name>/: plan.json, control/NNN/*.png, clips/NNN.mp4, final.mp4
"""
import os, platform
if platform.system() == "Darwin":
    os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0")
    os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")
import argparse, json, math, subprocess, time
import numpy as np
from PIL import Image
from common import OUT, log
from pose_control import draw, skeleton

FPS = 16
MAX_FRAMES = 81
W, H = 832, 480

CHARACTER = ("stylized CGI render of a young woman rock singer with big expressive eyes, tousled dark hair with red streaks, "
             "black leather jacket, holding a microphone")
STYLE = "Pixar style 3D animated music video, subsurface scattering skin, smooth animation, Disney Pixar animation movie, high quality"

# shot: (name, prompt fragment, skeleton scale, skeleton y-offset)  scale>1 = closer
SHOTS = {
    "close":  ("close-up of her face singing passionately into the microphone, shallow depth of field", 2.0, 0.42),
    "medium": ("medium shot, singing into the microphone and moving to the beat, cinematic camera", 1.25, 0.10),
    "wide":   ("wide shot of the whole stage with the singer at the center, drum kit and amplifiers behind her, dramatic haze", 0.85, -0.02),
    "low":    ("low angle medium shot, raising her fist to the sky, dramatic", 1.3, 0.12),
}
LIGHTS = {
    "low":  "dim blue and purple stage lights, moody, soft haze",
    "mid":  "warm rim light and soft volumetric stage lights",
    "high": "explosive warm orange stage lights, sparks and lens flares, crowd silhouettes in the foreground",
}


def plan_clips(audio, bpm):
    import librosa
    y, sr = librosa.load(audio, sr=22050, mono=True)
    dur = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=bpm or 120, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    beats = list(beats)
    period = float(np.median(np.diff(beats))) if len(beats) > 2 else 60 / (bpm or 120)
    beats_per_clip = 8 if period * 8 * FPS <= MAX_FRAMES else 4
    rms = librosa.feature.rms(y=y, hop_length=512)[0]
    rms_t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)
    cuts = [0.0] + [b for i, b in enumerate(beats) if i % beats_per_clip == 0 and b > 1.0] + [dur]
    clips = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1.0:
            continue
        n = int(round((b - a) * FPS))
        n = max(33, min(MAX_FRAMES, ((n - 1) // 4) * 4 + 1))  # 4k+1 frames
        e = float(np.mean(rms[(rms_t >= a) & (rms_t < b)])) if np.any((rms_t >= a) & (rms_t < b)) else 0.0
        clips.append({"start": round(a, 4), "frames": n, "energy": e})
    # energy tiers relative to the song, shots cycle with variety, chorus-like clips get the energetic shots
    es = np.array([c["energy"] for c in clips])
    lo, hi = np.percentile(es, 35), np.percentile(es, 70)
    cycle_hi, cycle_lo = ["medium", "close", "low", "wide"], ["medium", "close", "wide"]
    ih = il = 0
    for i, c in enumerate(clips):
        c["tier"] = "high" if c["energy"] >= hi else ("low" if c["energy"] <= lo else "mid")
        if c["tier"] == "high":
            c["shot"] = cycle_hi[ih % len(cycle_hi)]; ih += 1
        else:
            c["shot"] = cycle_lo[il % len(cycle_lo)]; il += 1
        c["prompt"] = f"{STYLE.split(',')[0]}, {CHARACTER}, {SHOTS[c['shot']][0]}, {LIGHTS[c['tier']]}, {STYLE.split(', ', 1)[1]}"
        c["seed"] = 100 + i
        c["index"] = i
    return {"audio": audio, "duration": dur, "tempo": tempo, "period": period, "beats_per_clip": beats_per_clip,
            "beats": [round(b, 4) for b in beats], "clips": clips}


def frame_kps(kps, scale, yoff):
    """Re-frame the normalised skeleton: scale about the figure's chest, then shift vertically."""
    cx, cy = 0.5, 0.30
    out = []
    for p in kps:
        x, y = cx + (p[0] - cx) * scale, cy + (p[1] - cy) * scale + yoff
        out.append((x, y) if -0.05 <= x <= 1.05 and -0.05 <= y <= 1.05 else None)
    return out


def control_frames(plan, clip, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    if len(list(out_dir.glob("*.png"))) == clip["frames"]:
        return [Image.open(out_dir / f"{i:03d}.png").convert("RGB") for i in range(clip["frames"])]
    beats, period = plan["beats"], plan["period"]
    _, scale, yoff = SHOTS[clip["shot"]][0], SHOTS[clip["shot"]][1], SHOTS[clip["shot"]][2]
    energy = {"low": 0.25, "mid": 0.6, "high": 1.0}[clip["tier"]]
    frames = []
    for i in range(clip["frames"]):
        t = clip["start"] + i / FPS
        prev = max([b for b in beats if b <= t], default=t)
        beat_phase = ((t - prev) / period) % 1.0
        nbeat = sum(1 for b in beats if b <= t)
        bar_phase = ((nbeat % 4) + beat_phase) / 4
        kps = skeleton(t - clip["start"], beat_phase, bar_phase, energy)
        kps = frame_kps(kps, scale, yoff)
        canvas = np.zeros((H, W, 3), np.uint8)
        im = Image.fromarray(draw(canvas, kps))
        im.save(out_dir / f"{i:03d}.png")
        frames.append(im)
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--ref", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--max-clips", type=int, default=None)
    a = ap.parse_args()
    root = OUT / "full" / a.name
    (root / "clips").mkdir(parents=True, exist_ok=True)
    plan_path = root / "plan.json"
    if plan_path.exists():
        plan = json.load(open(plan_path))
    else:
        plan = plan_clips(a.audio, a.bpm)
        json.dump(plan, open(plan_path, "w"), indent=1)
    clips = plan["clips"][: a.max_clips] if a.max_clips else plan["clips"]
    log(f"{a.name}: {plan['duration']:.1f}s, tempo {plan['tempo']:.1f}, {plan['beats_per_clip']} beats/clip, {len(clips)} clips, "
        f"tiers {dict(zip(*np.unique([c['tier'] for c in clips], return_counts=True)))}")
    for c in clips:
        control_frames(plan, c, root / "control" / f"{c['index']:03d}")
    if a.plan_only:
        log("plan + control frames written"); return

    import torch
    from diffusers.utils import export_to_video
    from common import DEVICE, IS_MPS, prompt_embeds_many, load_pipeline, free, mem_gb
    from generate import decode, ffmpeg_bin
    embeds = prompt_embeds_many(sorted({c["prompt"] for c in clips}))
    pipe = load_pipeline()
    if IS_MPS:
        pipe.vae.to(torch.bfloat16)
    ref = Image.open(a.ref).convert("RGB").resize((W, H))
    t_all = time.time()
    for c in clips:
        clip_mp4 = root / "clips" / f"{c['index']:03d}.mp4"
        if clip_mp4.exists():
            continue
        control = control_frames(plan, c, root / "control" / f"{c['index']:03d}")
        pos, neg = embeds[c["prompt"]]
        t0 = time.time()
        g = torch.Generator("cpu").manual_seed(c["seed"])
        latents = pipe(video=control, reference_images=[ref], prompt_embeds=pos, negative_prompt_embeds=neg,
                       height=H, width=W, num_frames=c["frames"], num_inference_steps=a.steps, guidance_scale=5.0,
                       conditioning_scale=1.0, generator=g, output_type="latent").frames
        torch.save(latents.cpu(), root / "clips" / f"{c['index']:03d}_latents.pt")
        frames = decode(latents)
        silent = root / "clips" / f"{c['index']:03d}_silent.mp4"
        export_to_video(frames, str(silent), fps=FPS)
        subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(silent), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(clip_mp4)], check=True)
        silent.unlink()
        free()
        log(f"clip {c['index']+1}/{len(clips)} {c['shot']}/{c['tier']} {c['frames']}f in {time.time()-t0:.0f}s, peak {mem_gb():.1f} GB, "
            f"elapsed {(time.time()-t_all)/60:.1f} min")
    # concat + full audio
    lst = root / "concat.txt"
    lst.write_text("".join(f"file '{(root / 'clips' / f'{c['index']:03d}.mp4').resolve()}'\n" for c in clips))
    final = root / "final.mp4"
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", a.audio,
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(final)], check=True)
    log(f"final video -> {final} ({(time.time()-t_all)/60:.1f} min total)")


if __name__ == "__main__":
    main()
