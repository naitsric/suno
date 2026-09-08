import os, sys, time, resource
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0"); os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")
import torch
from diffusers import AutoencoderKLWan
from common import MODEL_ID, OUT, log, mem_gb
dev = sys.argv[1]
z = torch.load(OUT / "clip_v1_latents.pt")[:, :, 1:]
vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32).to(dev).eval()
log(f"{dev}: vae loaded, driver {mem_gb():.2f} GB")
mean = torch.tensor(vae.config.latents_mean).view(1,16,1,1,1); std = 1/torch.tensor(vae.config.latents_std).view(1,16,1,1,1)
tile = (z[:, :, :2, :16, :16] / std + mean).to(dev)   # 2 latent frames of one 128x128 tile
with torch.no_grad():
    vae.clear_cache()
    t0 = time.time()
    for k in range(2):
        vae._conv_idx = [0]
        out = vae.decoder(vae.post_quant_conv(tile[:, :, k:k+1]), feat_cache=vae._feat_map, feat_idx=vae._conv_idx, first_chunk=(k == 0))
        if dev == "mps": torch.mps.synchronize()
        log(f"{dev}: frame {k} -> {tuple(out.shape)} in {time.time()-t0:.1f}s, driver {mem_gb():.2f} GB, rss {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/2**30:.1f} GB")
        t0 = time.time()
