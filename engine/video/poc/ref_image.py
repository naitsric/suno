"""Generate candidate Pixar-style reference portraits of the artist with VACE itself (num_frames=1)."""
import argparse, time
import torch
from common import OUT, DEVICE, log, mem_gb, prompt_embeds, load_pipeline, free

PROMPT = ("Pixar style 3D animated character, stylized CGI render of a young woman rock singer, "
          "big expressive eyes, tousled dark hair with red streaks, black leather jacket, holding a microphone, "
          "standing on a concert stage, warm rim light and soft volumetric stage lights, subsurface scattering skin, "
          "shallow depth of field, cinematic, medium close-up, centered, looking at camera, Disney Pixar animation movie still")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    pos, neg = prompt_embeds(PROMPT)
    pipe = load_pipeline()
    for i in range(a.n):
        g = torch.Generator("cpu").manual_seed(a.seed + i)
        t0 = time.time()
        out = pipe(prompt_embeds=pos, negative_prompt_embeds=neg, height=a.height, width=a.width, num_frames=1,
                   num_inference_steps=a.steps, guidance_scale=5.0, generator=g, output_type="pil").frames[0]
        path = OUT / f"ref_{a.seed+i}.png"
        out[0].save(path)
        log(f"ref {i+1}/{a.n} -> {path} in {time.time()-t0:.0f}s, peak mem {mem_gb():.1f} GB")
        free()


if __name__ == "__main__":
    main()
