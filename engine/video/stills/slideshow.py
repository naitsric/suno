"""ffmpeg assembly: still images → Ken Burns clips → beat-aligned crossfades → mux with the song."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def ffmpeg_bin() -> str:
    """imageio-ffmpeg's static build first: it has libass (subtitles) and drawtext, the Homebrew one may not."""
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        found = shutil.which("ffmpeg")
        if not found:
            raise
        return found


def build(
    images: list[Path],
    durations: list[float],
    audio: Path,
    out_mp4: Path,
    width: int = 1280,
    height: int = 720,
    fps: int = 24,
    fade: float = 0.8,
    total: float | None = None,
    subtitles: Path | None = None,
) -> Path:
    """`durations[i]` is how long scene i stays on screen (the crossfade overlaps the next scene).
    Each image gets a slow zoom/pan (alternating in/out) so the frame never feels frozen."""
    assert len(images) == len(durations) and images, "need at least one image"
    n = len(images)
    ff = ffmpeg_bin()
    args = [ff, "-y", "-loglevel", "error"]
    filters = []
    for i, (img, d) in enumerate(zip(images, durations)):
        # Every scene but the last lasts `fade` longer so the crossfade eats the overlap.
        d_in = d + (fade if i < n - 1 else 0.0)
        frames = max(int(round(d_in * fps)), 2)
        args += ["-loop", "1", "-framerate", str(fps), "-t", f"{d_in:.3f}", "-i", str(img)]
        zoom_in = i % 2 == 0
        # zoom from 1.0→1.18 (in) or 1.18→1.0 (out); pan drifts slowly toward one side
        z = f"min(1+0.18*on/{frames},1.18)" if zoom_in else f"max(1.18-0.18*on/{frames},1.0)"
        px = "iw/2-(iw/zoom/2)+(iw/zoom)*0.05*on/%d" % frames if i % 4 < 2 else "iw/2-(iw/zoom/2)-(iw/zoom)*0.05*on/%d" % frames
        py = "ih/2-(ih/zoom/2)"
        filters.append(
            f"[{i}:v]scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,crop={width * 2}:{height * 2},"
            f"zoompan=z='{z}':x='{px}':y='{py}':d={frames}:s={width}x{height}:fps={fps},format=yuv420p,setsar=1[v{i}]"
        )
    # chain of xfades: offset_k = sum(durations[:k+1]) (scene k ends there in output time)
    if n == 1:
        last = "v0"
    else:
        prev = "v0"
        offset = 0.0
        for k in range(1, n):
            offset += durations[k - 1]
            label = f"x{k}" if k < n - 1 else "vout"
            filters.append(f"[{prev}][v{k}]xfade=transition=fade:duration={fade}:offset={offset:.3f}[{label}]")
            prev = label
        last = "vout"
    if subtitles:
        # libass filter: escape the path for the filtergraph (':' and '\\' are special)
        sub = str(subtitles).replace("\\", "/").replace(":", "\\:")
        filters.append(f"[{last}]ass='{sub}'[vsub]")
        last = "vsub"
    args += ["-i", str(audio), "-filter_complex", ";".join(filters), "-map", f"[{last}]", "-map", f"{n}:a",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
             "-movflags", "+faststart"]
    if total:
        args += ["-t", f"{total:.3f}"]
    args += ["-shortest", str(out_mp4)]
    subprocess.run(args, check=True)
    return out_mp4
