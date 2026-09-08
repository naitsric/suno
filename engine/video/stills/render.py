"""Still images for a song with Wan 2.1 VACE (num_frames=1), reusing the PoC's pipeline helpers.

Identity is kept across scenes by passing the first rendered scene (or an artist portrait, when given)
as `reference_images` to every other scene: measured on M5 Pro 24 GB, 832x480 @ 25 steps = 32 s
without reference and 65 s with it, peak 15.5 GB MPS, character/outfit consistent.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Callable, Optional

HERE = Path(__file__).resolve().parent
POC = HERE.parent / "poc"
sys.path.insert(0, str(POC))  # read-only reuse of common.py (chunked SDPA, UMT5 cache, pipeline loader)

import torch  # noqa: E402
from PIL import Image  # noqa: E402

import common  # noqa: E402

CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
common.CACHE = CACHE  # keep our text-embedding cache apart from the PoC's

# Default look when the storyboard does not define one; normally the storyboard's "style" (derived from the
# artist's genre and description) replaces this, so a rock act, a bolero singer and an ambient project look different.
STYLE = "cinematic music video still, high detail, dramatic lighting, shallow depth of field, no text"

_pipe = None


def get_pipe():
    global _pipe
    if _pipe is None:
        _pipe = common.load_pipeline()
    return _pipe


def release_pipe():
    """Drop the transformer/VAE (~5 GB of MPS memory) between jobs so the music services keep their room."""
    global _pipe
    _pipe = None
    common.free()


def full_prompt(scene_prompt: str, character: str, style: str = "") -> str:
    return f"{style or STYLE}. {character}. {scene_prompt}"


def render_scenes(
    prompts: list[str],
    out_dir: Path,
    width: int = 832,
    height: int = 480,
    steps: int = 25,
    seed: int = 7,
    reference: Optional[Path] = None,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
) -> list[Path]:
    """Renders one PNG per prompt into out_dir. The first image (or `reference`) anchors the character."""
    out_dir.mkdir(parents=True, exist_ok=True)
    embeds = common.prompt_embeds_many(prompts)  # one UMT5-XXL load for all scenes, then released
    pipe = get_pipe()
    anchor = Image.open(reference).convert("RGB").resize((width, height)) if reference else None
    paths: list[Path] = []
    for i, prompt in enumerate(prompts):
        path = out_dir / f"scene_{i + 1:02d}.png"
        if path.exists():  # resume after a crash without re-rendering
            paths.append(path)
            if anchor is None:
                anchor = Image.open(path).convert("RGB")
            continue
        if on_progress:
            on_progress(i, len(prompts), "render")
        pos, neg = embeds[prompt]
        g = torch.Generator("cpu").manual_seed(seed + i)
        t0 = time.time()
        kwargs = dict(prompt_embeds=pos, negative_prompt_embeds=neg, height=height, width=width, num_frames=1,
                      num_inference_steps=steps, guidance_scale=5.0, generator=g, output_type="pil")
        if anchor is not None:
            kwargs["reference_images"] = [anchor]
        frames = pipe(**kwargs).frames[0]
        img = frames[-1]
        img.save(path)
        paths.append(path)
        common.log(f"scene {i + 1}/{len(prompts)} in {time.time() - t0:.0f}s, peak {common.mem_gb():.1f} GB")
        common.free()
        if anchor is None:
            anchor = img
    return paths


def render_portrait(prompt: str, out: Path, width: int = 832, height: int = 480, steps: int = 30, seed: int = 1) -> Path:
    """Single portrait (artist identity); same recipe as the PoC's ref_image.py."""
    pos, neg = common.prompt_embeds_many([prompt])[prompt]
    pipe = get_pipe()
    g = torch.Generator("cpu").manual_seed(seed)
    img = pipe(prompt_embeds=pos, negative_prompt_embeds=neg, height=height, width=width, num_frames=1,
               num_inference_steps=steps, guidance_scale=5.0, generator=g, output_type="pil").frames[0][0]
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    common.free()
    return out
