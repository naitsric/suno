"""On-screen lyrics: an ASS subtitle file with per-word karaoke fill, burned into the video with libass."""
from __future__ import annotations

from pathlib import Path

FONT = "Avenir Next"


def _ts(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("{", "(").replace("}", ")").replace("\\", "/")


def write_ass(lines: list[dict], out: Path, width: int = 1280, height: int = 720, karaoke: bool = True, accent: str = "&H0040C8FF") -> Path:
    """`lines`: [{text, start, end, words:[{text,start,end}]}] in seconds. Karaoke fills each word from
    white to the accent colour (ASS \\kf, centiseconds) as it is sung; lines fade in/out over 200 ms."""
    size = round(height * 0.075)
    margin_v = round(height * 0.085)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyric,{FONT},{size},{accent},&H00FFFFFF,&H90000000,&H90000000,-1,0,0,0,100,100,0.5,0,1,2.4,1.6,2,{round(width * 0.06)},{round(width * 0.06)},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for ln in lines:
        start, end = float(ln["start"]), float(ln["end"])
        if end - start < 0.4:
            end = start + 0.4
        lead = 0.15  # show the line slightly before the first word
        s0 = max(0.0, start - lead)
        parts = []
        words = ln.get("words") or []
        if karaoke and words:
            first_gap = max(0.0, float(words[0]["start"]) - s0)
            if first_gap > 0:
                parts.append(f"{{\\kf{int(round(first_gap * 100))}}}")
            for w in words:
                dur = max(0.05, float(w["end"]) - float(w["start"]))
                parts.append(f"{{\\kf{int(round(dur * 100))}}}{_esc(w['text'])} ")
            text = "".join(parts).rstrip()
        else:
            text = _esc(ln["text"])
        events.append(f"Dialogue: 0,{_ts(s0)},{_ts(end + 0.2)},Lyric,,0,0,0,,{{\\fad(200,200)}}{text}")
    out.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out
