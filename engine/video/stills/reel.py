"""Reels verticales (1080x1920, ~25 s) de las canciones de un álbum: portada con movimiento suave,
título y artista, y la letra en karaoke sincronizada. Sin IA: PIL + ffmpeg (libass).

Uso (desde engine/video/stills, con ../.venv):
  python reel.py --album "Las cosas sencillas" [--seconds 25] [--align-only] [--song "Las Llaves"]

La letra con tiempos se pide una vez al servicio de voz (:8002, POST /align-lyrics) y se cachea en
out/reels/<songId>.lyrics.json; las canciones cuyo storyboard ya trae `lyrics` alineadas no lo necesitan.
El fragmento es el primer coro ([Chorus] de la letra) o, si no se encuentra, la ventana de más energía.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from slideshow import ffmpeg_bin  # noqa: E402
from subtitles import _esc, _ts  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]  # repo Suno
DB = ROOT / "web" / "data" / "suno.db"
AUDIO = ROOT / "web" / "data" / "audio"
IMAGES = ROOT / "web" / "data" / "images"
OUT = Path(__file__).parent / "out" / "reels"
VOICE = "http://127.0.0.1:8002"
W, H, FPS = 1080, 1920, 30
FONT_BOLD = "/System/Library/Fonts/Avenir Next.ttc"


# ---------- datos ----------
def album_songs(album_name: str, song_title: str | None = None) -> tuple[dict, dict, list[dict]]:
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    album = db.execute("select * from albums where lower(name)=lower(?)", (album_name,)).fetchone()
    if not album:
        raise SystemExit(f"no existe el álbum {album_name!r}")
    artist = db.execute("select * from artists where id=?", (album["artist_id"],)).fetchone()
    q = "select * from songs where album_id=? and status='done'"
    rows = db.execute(q, (album["id"],)).fetchall()
    songs = [dict(r) for r in rows if not song_title or r["title"].lower() == song_title.lower()]
    if not songs:
        raise SystemExit("no hay canciones que coincidan")
    return dict(album), dict(artist), songs


def image_of(kind: str, id_: str, image_file: str | None) -> Path:
    p = Path(image_file) if image_file else None
    if p and not p.is_absolute():
        p = IMAGES / kind / p.name
    if not p or not p.exists():
        cands = sorted((IMAGES / kind).glob(f"{id_}*.png"))
        if not cands:
            raise SystemExit(f"sin imagen de {kind} para {id_}")
        p = cands[-1]
    return p


# ---------- letra con tiempos ----------
def timed_lyrics(song: dict) -> list[dict]:
    """[{text,start,end,words:[{text,start,end}]}] en segundos, cacheado por canción."""
    cache = OUT / f"{song['id']}.lyrics.json"
    if cache.exists():
        return json.loads(cache.read_text())["lines"]
    sb = song.get("storyboard")
    if sb:
        try:
            lines = json.loads(sb).get("lyrics") or []
        except json.JSONDecodeError:
            lines = []
        if lines:
            cache.write_text(json.dumps({"source": "storyboard", "lines": lines}, ensure_ascii=False))
            return lines
    import requests

    print(f"  alineando letra con el servicio de voz ({song['title']})…", flush=True)
    mp3 = AUDIO / f"{song['id']}.mp3"
    with mp3.open("rb") as f:
        r = requests.post(f"{VOICE}/align-lyrics", files={"audio": (mp3.name, f, "audio/mpeg")}, data={"lyrics": song["lyrics"], "language": "es", "model": "medium", "duration": song.get("duration") or 0}, timeout=1800)
    r.raise_for_status()
    res = r.json()
    lines = res["lines"]
    cache.write_text(json.dumps({"source": "align-lyrics", "confidence": res.get("confidence"), "lines": lines}, ensure_ascii=False))
    print(f"  confianza {res.get('confidence')}", flush=True)
    return lines


def chorus_index(lyrics_text: str) -> int | None:
    """Índice (entre las líneas sin etiqueta) de la primera línea del primer [Chorus]. Las líneas
    alineadas siguen ese mismo orden, así que el índice evita confundir el coro con el intro
    cuando repiten texto."""
    idx = 0
    inside = False
    for raw in lyrics_text.splitlines():
        ln = raw.strip()
        if not ln:
            continue
        if ln.startswith("[") and ln.endswith("]"):
            tag = ln.strip("[]").strip().lower()
            inside = bool(tag) and tag.split()[0] in ("chorus", "coro")  # "[Chorus]", "[Chorus 2]"; no "[Pre-Chorus]"
            continue
        if inside:
            return idx
        idx += 1
    return None


def norm(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def pick_window(song: dict, lines: list[dict], seconds: float) -> tuple[float, float]:
    """Inicio y fin del fragmento: primer coro (alineado a inicio de línea) o ventana de más energía."""
    ci = chorus_index(song["lyrics"] or "")
    start = None
    if ci is not None and ci < len(lines):
        ln = lines[ci]
        plain = [l.strip() for l in (song["lyrics"] or "").splitlines() if l.strip() and not l.strip().startswith("[")]
        # Solo si la línea alineada es la que esperamos (mismo texto) y tiene tiempos creíbles.
        if ci < len(plain) and norm(ln["text"]) == norm(plain[ci]) and float(ln["end"]) > float(ln["start"]):
            start = float(ln["start"])
    if start is None:
        start = loudest_start(AUDIO / f"{song['id']}.mp3", seconds)
        # empezar en el inicio de la línea más cercana, si hay alguna cerca
        near = [float(l["start"]) for l in lines if abs(float(l["start"]) - start) < 2.5]
        if near:
            start = min(near, key=lambda t: abs(t - start))
    start = max(0.0, start - 0.25)
    end = start + seconds
    # El alineador a veces "aprieta" varias líneas en un segundo (tiempos inventados entre anclas):
    # si eso ocurre dentro de la ventana y ya llevamos ≥ 15 s buenos, cortamos antes del tramo malo.
    after = [l for l in lines if float(l["start"]) >= start]
    for i in range(len(after) - 2):
        if all(float(after[i + k]["end"]) - float(after[i + k]["start"]) < 0.7 for k in range(3)):
            bad_at = float(after[i]["start"])
            if bad_at - start >= 15 and bad_at < end:
                end = bad_at
            break
    # terminar al final de una línea, para no cortar una palabra
    target = end
    ends = [float(l["end"]) for l in lines if target - seconds * 0.3 <= float(l["end"]) <= target + 3]
    if ends:
        end = min(ends, key=lambda t: abs(t - target)) + 0.35
    dur = float(song.get("duration") or 0) or end
    return start, min(end, dur)


def loudest_start(mp3: Path, seconds: float) -> float:
    import librosa
    import numpy as np

    y, sr = librosa.load(str(mp3), sr=22050, mono=True)
    hop = 2048
    rms = librosa.feature.rms(y=y, frame_length=4096, hop_length=hop)[0]
    win = max(1, int(seconds * sr / hop))
    if len(rms) <= win:
        return 0.0
    sums = np.convolve(rms, np.ones(win), mode="valid")
    return float(np.argmax(sums) * hop / sr)


# ---------- imagen de fondo/frente ----------
def font(size: int, index: int = 5) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_BOLD, size, index=index)  # index 5 ≈ Avenir Next Bold en el .ttc
    except OSError:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size)


def compose_layers(cover: Path, artist: str, title: str, out_dir: Path) -> tuple[Path, Path]:
    """bg.png: portada difuminada y oscurecida a pantalla completa. fg.png (RGBA): portada redondeada + títulos."""
    img = Image.open(cover).convert("RGB")
    bg = img.resize((W, W)).crop((0, 0, W, W))
    bg = Image.new("RGB", (W, H), (10, 8, 12)).copy()
    big = img.resize((H, H))
    bg.paste(big.crop(((H - W) // 2, 0, (H - W) // 2 + W, H)), (0, 0))
    bg = bg.filter(ImageFilter.GaussianBlur(38))
    bg = Image.blend(bg, Image.new("RGB", (W, H), (0, 0, 0)), 0.45)
    bg_path = out_dir / "bg.png"
    bg.save(bg_path)

    fg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    size = 860
    art = img.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=54, fill=255)
    shadow = Image.new("RGBA", (size + 120, size + 120), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((60, 70, size + 60, size + 70), radius=54, fill=(0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    x, y = (W - size) // 2, 300
    fg.alpha_composite(shadow, (x - 60, y - 60))
    fg.paste(art, (x, y), mask)
    d = ImageDraw.Draw(fg)
    f_artist, f_title = font(44), font(78)
    up = artist.upper()
    d.text((W / 2, 175), up, font=f_artist, fill=(255, 255, 255, 215), anchor="mm", stroke_width=2, stroke_fill=(0, 0, 0, 120))
    d.text((W / 2, 245), "— " + title + " —", font=f_title, fill=(255, 226, 90, 255), anchor="mm", stroke_width=3, stroke_fill=(0, 0, 0, 160))
    fg_path = out_dir / "fg.png"
    fg.save(fg_path)
    return bg_path, fg_path


# ---------- subtítulos karaoke ----------
def write_reel_ass(lines: list[dict], offset: float, out: Path, size: int = 64, accent: str = "&H005AE2FF") -> Path:
    """Como subtitles.write_ass pero con tamaño propio para 1080x1920 y tiempos relativos al fragmento."""
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyric,Avenir Next,{size},{accent},&H00FFFFFF,&HA0000000,&HA0000000,-1,0,0,0,100,100,0.5,0,1,3,2,2,70,70,{round(H * 0.20)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for i, ln in enumerate(lines):
        start, end = float(ln["start"]) - offset, float(ln["end"]) - offset
        if end < 0:
            continue
        if end - start < 0.4:
            end = start + 0.4
        s0 = max(0.0, start - 0.15)
        # Sin solaparse con la línea siguiente: libass apilaría las dos.
        nxt = float(lines[i + 1]["start"]) - offset - 0.15 if i + 1 < len(lines) else None
        if nxt is not None:
            end = min(end + 0.2, max(nxt - 0.02, start + 0.3)) - 0.2
        words = ln.get("words") or []
        if words:
            parts = []
            gap = max(0.0, float(words[0]["start"]) - offset - s0)
            if gap > 0:
                parts.append(f"{{\\kf{int(round(gap * 100))}}}")
            for w in words:
                dur = max(0.05, float(w["end"]) - float(w["start"]))
                parts.append(f"{{\\kf{int(round(dur * 100))}}}{_esc(w['text'])} ")
            text = "".join(parts).rstrip()
        else:
            text = _esc(ln["text"])
        events.append(f"Dialogue: 0,{_ts(s0)},{_ts(end + 0.2)},Lyric,,0,0,0,,{{\\fad(150,150)}}{text}")
    out.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out


# ---------- render ----------
def render(song: dict, artist: dict, cover: Path, seconds: float) -> Path:
    out_dir = OUT / song["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = timed_lyrics(song)
    start, end = pick_window(song, lines, seconds)
    dur = end - start
    bg, fg = compose_layers(cover, artist["name"], song["title"], out_dir)
    ass = write_reel_ass([l for l in lines if float(l["end"]) > start and float(l["start"]) < end], start, out_dir / "lyrics.ass")
    mp3 = AUDIO / f"{song['id']}.mp3"
    out = OUT / f"{slug(song['title'])}.mp4"
    frames = int(round(dur * FPS))
    ass_path = str(ass).replace("\\", "/").replace(":", "\\:")
    fc = ";".join([
        f"[0:v]scale={W * 2}:{H * 2},zoompan=z='min(1.0+0.06*on/{frames},1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS},format=yuv420p[bg]",
        f"[bg][1:v]overlay=x=0:y='6*sin(t*1.1)':shortest=1,format=yuv420p[v1]",
        f"[v1]ass='{ass_path}'[v2]",
        f"[v2]fade=t=in:st=0:d=0.5,fade=t=out:st={max(0.0, dur - 0.8):.2f}:d=0.8[vout]",
        f"[2:a]afade=t=in:st=0:d=0.8,afade=t=out:st={max(0.0, dur - 1.5):.2f}:d=1.5[aout]",
    ])
    args = [ffmpeg_bin(), "-y", "-loglevel", "error",
            "-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(bg),
            "-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(fg),
            "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(mp3),
            "-filter_complex", fc, "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", "-shortest", str(out)]
    subprocess.run(args, check=True)
    (out_dir / "reel.json").write_text(json.dumps({"song": song["id"], "title": song["title"], "start": start, "end": end, "output": str(out)}, ensure_ascii=False, indent=1))
    print(f"✔ {song['title']}: {start:.1f}s → {end:.1f}s ({dur:.1f}s) → {out}", flush=True)
    return out


def slug(s: str) -> str:
    import re
    import unicodedata

    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--album", required=True)
    ap.add_argument("--song", help="solo esta canción (título)")
    ap.add_argument("--seconds", type=float, default=25.0)
    ap.add_argument("--align-only", action="store_true", help="solo alinear letras (no renderiza)")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    album, artist, songs = album_songs(a.album, a.song)
    cover = image_of("albums", album["id"], album.get("image_file"))
    print(f"{artist['name']} · {album['name']}: {len(songs)} canciones · portada {cover.name}")
    for s in songs:
        print(f"▶ {s['title']}", flush=True)
        if a.align_only:
            timed_lyrics(s)
        else:
            render(s, artist, cover, a.seconds)


if __name__ == "__main__":
    main()
