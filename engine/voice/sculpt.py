"""Voice sculpting: reshape a reference's timbre so an artist's voice becomes one of a kind.

Praat's "Change gender" (PSOLA, via parselmouth) moves the formants — the perceived size of the vocal
tract: negative = bigger and darker, positive = smaller and brighter — and the pitch median
independently of each other; a high shelf at 3 kHz adds or removes "air". CPU only, ~8 s for a 30 s
reference. Used by POST /sculpt-reference; the web keeps the result as `<voice>.sculpt.wav` next to
the original, which is never modified.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
LIMITS = {"formant_pct": 30.0, "pitch_st": 12.0, "brightness_db": 12.0}


def _high_shelf(y: np.ndarray, sr: int, gain_db: float, freq: float = 3000.0, slope: float = 0.9) -> np.ndarray:
    """RBJ audio-EQ-cookbook high shelf."""
    from scipy.signal import lfilter

    a = 10 ** (gain_db / 40)
    w0 = 2 * math.pi * freq / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / 2 * math.sqrt((a + 1 / a) * (1 / slope - 1) + 2)
    sa = 2 * math.sqrt(a) * alpha
    b = [a * ((a + 1) + (a - 1) * cw + sa), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - sa)]
    a0 = (a + 1) - (a - 1) * cw + sa
    a_ = [a0, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - sa]
    return lfilter([c / a0 for c in b], [c / a0 for c in a_], y).astype(np.float32)


def _centroid_hz(y: np.ndarray, sr: int) -> float:
    import librosa

    return float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())


def sculpt_file(src: Path, out: Path, formant_pct: float, pitch_st: float, brightness_db: float) -> dict:
    """Writes the sculpted reference (WAV mono 44.1 kHz) and returns before/after measurements."""
    import librosa
    import parselmouth
    from parselmouth.praat import call

    for name, value in (("formant_pct", formant_pct), ("pitch_st", pitch_st), ("brightness_db", brightness_db)):
        if not (-LIMITS[name] <= value <= LIMITS[name]):
            raise ValueError(f"{name} fuera de rango (±{LIMITS[name]:g})")

    snd = parselmouth.Sound(str(src))
    if snd.n_channels > 1:
        snd = snd.convert_to_mono()
    x = snd.values[0].astype(np.float32)
    sr_in = int(snd.sampling_frequency)

    pitch = snd.to_pitch(pitch_floor=60, pitch_ceiling=900)
    f0 = pitch.selected_array["frequency"]
    f0 = f0[f0 > 0]
    median = float(np.median(f0)) if f0.size else 0.0
    new_median = median * 2 ** (pitch_st / 12) if (median and abs(pitch_st) > 1e-6) else 0.0

    if abs(formant_pct) > 1e-6 or new_median:
        # (pitch floor, pitch ceiling, formant shift ratio, new pitch median [0 = keep], pitch range factor, duration factor)
        res = call(snd, "Change gender", 60, 900, 1 + formant_pct / 100, new_median, 1.0, 1.0)
        y = res.values[0].astype(np.float32)
        sr = int(res.sampling_frequency)
    else:
        y, sr = x.copy(), sr_in

    if abs(brightness_db) > 1e-6:
        y = _high_shelf(y, sr, brightness_db)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
        sr = SR
    peak = float(np.abs(y).max()) or 1.0
    if peak > 0.98:
        y = y * (0.98 / peak)
    sf.write(out, y, sr)

    return {
        "formant_pct": formant_pct,
        "pitch_st": pitch_st,
        "brightness_db": brightness_db,
        "f0_median_before_hz": round(median),
        "f0_median_after_hz": round(new_median or median),
        "centroid_before_hz": round(_centroid_hz(x, sr_in)),
        "centroid_after_hz": round(_centroid_hz(y, sr)),
    }
