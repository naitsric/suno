"""Try VAE decode configurations on MPS over the saved latents, keep the first that fits."""
import os, sys, json, time
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")
import torch
from diffusers import AutoencoderKLWan
from diffusers.video_processor import VideoProcessor
from common import OUT, MODEL_ID, log, mem_gb, free
from generate import mux

name = sys.argv[1] if len(sys.argv) > 1 else "clip_v1"
latents = torch.load(OUT / f"{name}_latents.pt")[:, :, 1:]
meta = json.load(open(OUT / "control.json"))
processor = VideoProcessor(vae_scale_factor=8)
configs = [("cpu-fp32-tile128", "cpu", torch.float32, 128, 96)]
for label, dev, dtype, tile, stride in configs:
    try:
        vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=dtype).to(dev).eval()
        vae.enable_tiling(tile_sample_min_height=tile, tile_sample_min_width=tile, tile_sample_stride_height=stride, tile_sample_stride_width=stride)
        mean = torch.tensor(vae.config.latents_mean).view(1, 16, 1, 1, 1).to(dev, dtype)
        std = 1.0 / torch.tensor(vae.config.latents_std).view(1, 16, 1, 1, 1).to(dev, dtype)
        z = latents.to(dev, dtype) / std + mean
        log(f"[{label}] decoding {tuple(z.shape)}")
        t0 = time.time()
        with torch.no_grad():
            video = vae.decode(z, return_dict=False)[0]
        frames = processor.postprocess_video(video.float().cpu(), output_type="pil")[0]
        log(f"[{label}] OK {len(frames)} frames in {time.time()-t0:.0f}s, driver mem {mem_gb():.1f} GB")
        mux(frames, meta, name)
        json.dump({"decode_config": label, "decode_seconds": round(time.time()-t0), "frames": len(frames)}, open(OUT / f"{name}_decode.json", "w"))
        break
    except RuntimeError as e:
        log(f"[{label}] failed: {str(e)[:200]}")
        del vae; free(); time.sleep(5)
