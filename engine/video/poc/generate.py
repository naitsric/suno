"""Reference image + OpenPose control video -> Pixar-style clip with Wan 2.1 VACE 1.3B, then mux the song audio.

Robustness on a shared 24 GB Mac: the MPS allocator is capped so the process fails fast instead of pushing the
whole machine into swap, the cache is trimmed every step, and the denoised latents are saved to disk BEFORE the
VAE decode so a decode failure never loses 30+ minutes of denoising (`--decode-only` resumes from them).
"""
import os, platform
if platform.system() == "Darwin":
    os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0")
    os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")
import argparse, json, subprocess, time
import torch
from PIL import Image
from diffusers.utils import export_to_video
from common import OUT, DEVICE, IS_MPS, log, mem_gb, alloc_gb, prompt_embeds, load_pipeline, free

PROMPT = ("Pixar style 3D animated music video, stylized CGI render of a young woman rock singer with big expressive eyes, "
          "tousled dark hair with red streaks, black leather jacket, singing passionately into a microphone and moving "
          "to the beat on a concert stage, raising her fist, warm rim light and soft volumetric stage lights, "
          "subsurface scattering skin, shallow depth of field, cinematic camera, smooth animation, "
          "Disney Pixar animation movie, high quality")


def decode(latents):
    from diffusers import AutoencoderKLWan
    from diffusers.video_processor import VideoProcessor
    from common import MODEL_ID
    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)  # fresh fp32 weights
    processor = VideoProcessor(vae_scale_factor=8)
    vae.enable_slicing()
    latents = latents[:, :, 1:]  # drop the reference-image latent frame, as the pipeline does
    if not IS_MPS:  # CUDA with 24+ GB decodes 81 frames at 832x480 directly
        return _decode_on(vae, processor, latents, DEVICE)
    # 128 px tiles: conv3d on this Mac is im2col-based, so a 4-frame chunk at full 832x480 needs ~16 GB of
    # workspace (32 GB RSS on CPU, and on MPS ~15 GB of "other allocations" that never fit under the cap).
    vae.enable_tiling(tile_sample_min_height=128, tile_sample_min_width=128, tile_sample_stride_height=96, tile_sample_stride_width=96)
    # MPS decode fails deterministically (15 GB of driver-side allocations even with 128 px tiles); measured 2026-09-08:
    # CPU fp32 + 128 px tiles = 596 s for 81 frames at 832x480 with a flat 3.5 GB RSS. Keep it on CPU.
    return _decode_on(vae, processor, latents, "cpu")


def _decode_on(vae, processor, latents, dev):
    mean = torch.tensor(vae.config.latents_mean).view(1, vae.config.z_dim, 1, 1, 1)
    std = 1.0 / torch.tensor(vae.config.latents_std).view(1, vae.config.z_dim, 1, 1, 1)
    log(f"decoding {tuple(latents.shape)} on {dev}")
    vae.to(dev)
    z = latents.to(dev, vae.dtype) / std.to(dev, vae.dtype) + mean.to(dev, vae.dtype)
    with torch.no_grad():
        video = vae.decode(z, return_dict=False)[0]
    return processor.postprocess_video(video.cpu(), output_type="pil")[0]


def ffmpeg_bin():
    import shutil
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    import imageio_ffmpeg  # bundled binary, always present in the venv
    return imageio_ffmpeg.get_ffmpeg_exe()


def mux(frames, meta, name):
    silent = OUT / f"{name}_silent.mp4"
    export_to_video(frames, str(silent), fps=meta["fps"])
    final = OUT / f"{name}.mp4"
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(silent), "-ss", str(meta["start"]), "-t", str(len(frames) / meta["fps"]),
                    "-i", meta["audio"], "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(final)], check=True)
    log(f"wrote {final}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--frames", type=int, default=None)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cond", type=float, default=1.0)
    ap.add_argument("--name", default="clip")
    ap.add_argument("--decode-only", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="ignore an existing per-step checkpoint")
    a = ap.parse_args()
    meta = json.load(open(OUT / "control.json"))
    n = a.frames or meta["frames"]
    latents_path = OUT / f"{a.name}_latents.pt"
    ckpt_path = OUT / f"{a.name}_ckpt.pt"
    pipe = None if a.decode_only else load_pipeline()

    # --- per-step checkpoint / resume -------------------------------------------------------------
    k0, init_latents = 0, None
    if ckpt_path.exists() and not a.fresh and not a.decode_only:
        ck = torch.load(ckpt_path)
        if ck.get("steps") == a.steps and ck.get("frames") == n and ck.get("seed") == a.seed:
            k0, init_latents = ck["step"], ck["latents"]
            log(f"resuming from checkpoint at step {k0}/{a.steps}")
        else:
            log("checkpoint config mismatch, starting fresh")
    if k0:
        _orig_set = pipe.scheduler.set_timesteps

        def _trimmed(num_inference_steps=None, device=None, **kw):
            _orig_set(num_inference_steps, device=device, **kw)
            sch = pipe.scheduler
            sch.timesteps, sch.sigmas = sch.timesteps[k0:], sch.sigmas[k0:]
            sch.num_inference_steps = len(sch.timesteps)
        pipe.scheduler.set_timesteps = _trimmed

    def save_ckpt(step, latents):
        tmp = ckpt_path.with_suffix(".tmp")
        torch.save({"step": step, "steps": a.steps, "frames": n, "seed": a.seed, "latents": latents.detach().cpu()}, tmp)
        os.replace(tmp, ckpt_path)
    stats = {"ref": a.ref, "steps": a.steps, "frames": n, "cond": a.cond, "seed": a.seed, "step_seconds": []}

    if not a.decode_only:
        control = [Image.open(OUT / "control" / f"{i:03d}.png").convert("RGB") for i in range(n)]
        ref = Image.open(a.ref).convert("RGB").resize((meta["width"], meta["height"]))
        pos, neg = prompt_embeds(PROMPT)
        g = torch.Generator("cpu").manual_seed(a.seed)
        if IS_MPS:
            pipe.vae.to(torch.bfloat16)  # encode control/reference in bf16 to stay under the MPS cap
        log(f"generating {n} frames {meta['width']}x{meta['height']} steps={a.steps} cond={a.cond} on {DEVICE}")
        t0 = time.time()
        last = [t0]

        def on_step(p, i, t, kw):
            now = time.time()
            stats["step_seconds"].append(round(now - last[0], 1))
            last[0] = now
            step = k0 + i + 1
            save_ckpt(step, kw["latents"])
            free()
            log(f"step {step}/{a.steps} {stats['step_seconds'][-1]:.0f}s  alloc {alloc_gb():.1f} GB  peak/driver {mem_gb():.1f} GB")
            return {}

        if k0 >= a.steps:
            latents = init_latents.to(DEVICE)
        else:
          latents = pipe(video=control, reference_images=[ref], prompt_embeds=pos, negative_prompt_embeds=neg,
                       height=meta["height"], width=meta["width"], num_frames=n, num_inference_steps=a.steps,
                       guidance_scale=5.0, conditioning_scale=a.cond, generator=g, output_type="latent",
                       latents=None if init_latents is None else init_latents.to(DEVICE),
                       callback_on_step_end=on_step).frames
        stats["denoise_seconds"] = round(time.time() - t0)
        stats["resumed_from"] = k0
        torch.save(latents.cpu(), latents_path)
        log(f"denoised in {stats['denoise_seconds']}s, latents saved -> {latents_path}")
        del pipe
        free()
    else:
        latents = torch.load(latents_path)

    t1 = time.time()
    frames = decode(latents)
    stats["decode_seconds"] = round(time.time() - t1)
    log(f"decoded {len(frames)} frames in {stats['decode_seconds']}s, peak driver mem {mem_gb():.1f} GB")
    mux(frames, meta, a.name)
    json.dump(stats, open(OUT / f"{a.name}.json", "w"), indent=2)


if __name__ == "__main__":
    main()
