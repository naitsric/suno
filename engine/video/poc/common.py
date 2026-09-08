"""Shared helpers for the Wan 2.1 VACE proof of concept on Apple Silicon (MPS)."""
import gc, hashlib, os, time
from pathlib import Path

import torch
import torch.nn.functional as F

MODEL_ID = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-VACE-1.3B-diffusers")  # e.g. Wan-AI/Wan2.1-VACE-14B-diffusers
DEVICE = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
IS_MPS = DEVICE == "mps"
DTYPE = torch.bfloat16
HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
OUT = HERE / "out"
CACHE.mkdir(exist_ok=True)
OUT.mkdir(exist_ok=True)

NEGATIVE = ("Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, "
            "images, static, overall gray, worst quality, low quality, JPEG compression residue, ugly, "
            "incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, "
            "misshapen limbs, fused fingers, still picture, messy background, three legs, many people "
            "in the background, walking backwards, photorealistic, live action, real photo")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def mem_gb():
    if DEVICE == "mps":
        return torch.mps.driver_allocated_memory() / 2**30
    if DEVICE == "cuda":
        return torch.cuda.max_memory_allocated() / 2**30
    return 0.0


def alloc_gb():
    if DEVICE == "mps":
        return torch.mps.current_allocated_memory() / 2**30
    if DEVICE == "cuda":
        return torch.cuda.memory_allocated() / 2**30
    return 0.0


def free():
    gc.collect()
    if DEVICE == "mps":
        torch.mps.empty_cache()
    elif DEVICE == "cuda":
        torch.cuda.empty_cache()


# --- chunked attention: avoid materialising a 32k x 32k score matrix on MPS ---
_orig_sdpa = F.scaled_dot_product_attention
_CHUNK_BUDGET = 4096 * 4096


def _chunked_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, **kw):
    L, S = query.shape[-2], key.shape[-2]
    if attn_mask is None and not is_causal and L * S > _CHUNK_BUDGET:
        step = max(64, _CHUNK_BUDGET // S)
        outs = [_orig_sdpa(query[..., i:i + step, :], key, value, dropout_p=dropout_p, scale=scale, **kw)
                for i in range(0, L, step)]
        return torch.cat(outs, dim=-2)
    return _orig_sdpa(query, key, value, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal, scale=scale, **kw)


if IS_MPS:  # CUDA SDPA is flash/mem-efficient already
    F.scaled_dot_product_attention = _chunked_sdpa


def prompt_embeds(prompt, negative=NEGATIVE, max_len=512):
    """Encode with UMT5-XXL once, cache to disk, and keep the 11 GB encoder out of memory afterwards."""
    key = hashlib.sha1(f"{prompt}\n###\n{negative}".encode()).hexdigest()[:16]
    path = CACHE / f"embeds_{key}.pt"
    if path.exists():
        d = torch.load(path)
        return d["pos"].to(DEVICE, DTYPE), d["neg"].to(DEVICE, DTYPE)
    from transformers import AutoTokenizer, UMT5EncoderModel
    log("loading UMT5-XXL text encoder")
    tok = AutoTokenizer.from_pretrained(MODEL_ID, subfolder="tokenizer")
    enc = UMT5EncoderModel.from_pretrained(MODEL_ID, subfolder="text_encoder", torch_dtype=DTYPE).to(DEVICE)
    log(f"text encoder on {DEVICE}, mem {mem_gb():.1f} GB")

    def encode(text):
        t = tok([text], padding="max_length", max_length=max_len, truncation=True,
                add_special_tokens=True, return_attention_mask=True, return_tensors="pt")
        mask = t.attention_mask
        n = mask.sum(dim=1).long()
        with torch.no_grad():
            h = enc(t.input_ids.to(DEVICE), mask.to(DEVICE)).last_hidden_state
        h = [u[:s] for u, s in zip(h, n)]
        h = torch.stack([torch.cat([u, u.new_zeros(max_len - u.size(0), u.size(1))]) for u in h])
        return h.cpu()

    pos, neg = encode(prompt), encode(negative)
    torch.save({"pos": pos, "neg": neg, "prompt": prompt}, path)
    del enc
    free()
    log(f"text encoder released, mem {mem_gb():.1f} GB")
    return pos.to(DEVICE, DTYPE), neg.to(DEVICE, DTYPE)


def prompt_embeds_many(prompts, negative=NEGATIVE, max_len=512):
    """Encode several prompts with ONE load of UMT5-XXL (each call to prompt_embeds would reload the 11 GB encoder)."""
    keys = {p: hashlib.sha1(f"{p}\n###\n{negative}".encode()).hexdigest()[:16] for p in prompts}
    missing = [p for p in prompts if not (CACHE / f"embeds_{keys[p]}.pt").exists()]
    if missing:
        from transformers import AutoTokenizer, UMT5EncoderModel
        log(f"loading UMT5-XXL text encoder for {len(missing)} prompts")
        tok = AutoTokenizer.from_pretrained(MODEL_ID, subfolder="tokenizer")
        enc = UMT5EncoderModel.from_pretrained(MODEL_ID, subfolder="text_encoder", torch_dtype=DTYPE).to(DEVICE)

        def encode(text):
            t = tok([text], padding="max_length", max_length=max_len, truncation=True,
                    add_special_tokens=True, return_attention_mask=True, return_tensors="pt")
            n = t.attention_mask.sum(dim=1).long()
            with torch.no_grad():
                h = enc(t.input_ids.to(DEVICE), t.attention_mask.to(DEVICE)).last_hidden_state
            h = [u[:s] for u, s in zip(h, n)]
            return torch.stack([torch.cat([u, u.new_zeros(max_len - u.size(0), u.size(1))]) for u in h]).cpu()

        neg = encode(negative)
        for p in missing:
            torch.save({"pos": encode(p), "neg": neg, "prompt": p}, CACHE / f"embeds_{keys[p]}.pt")
        del enc
        free()
        log("text encoder released")
    out = {}
    for p in prompts:
        d = torch.load(CACHE / f"embeds_{keys[p]}.pt")
        out[p] = (d["pos"].to(DEVICE, DTYPE), d["neg"].to(DEVICE, DTYPE))
    return out


def load_pipeline(flow_shift=3.0):
    from diffusers import AutoencoderKLWan, WanVACEPipeline
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
    log("loading VACE 1.3B transformer + VAE")
    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    extra = {}
    if DEVICE == "cuda":
        # load the transformer shards straight onto the GPU: the 14B checkpoint blew past 60 GB of host RAM otherwise
        from diffusers import WanVACETransformer3DModel
        extra["transformer"] = WanVACETransformer3DModel.from_pretrained(MODEL_ID, subfolder="transformer", torch_dtype=DTYPE, device_map="cuda")
    pipe = WanVACEPipeline.from_pretrained(MODEL_ID, vae=vae, text_encoder=None, tokenizer=None, torch_dtype=DTYPE, **extra)
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=flow_shift)
    # tiling OOMed the encode on MPS; slicing only
    pipe.vae.enable_slicing()
    pipe.to(DEVICE)
    pipe.set_progress_bar_config(disable=False)
    log(f"pipeline on {DEVICE}, mem {mem_gb():.1f} GB")
    return pipe
