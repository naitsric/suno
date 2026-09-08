"""Voice conversion service: makes a generated song sound like the user's voice.

Pipeline per job:
  1. Demucs (htdemucs) splits the song into vocals + instrumental.
  2. Seed-VC converts the vocal stem to the reference timbre (F0-conditioned singing model,
     auto_f0_adjust disabled so the melody stays in the song's key). Before that, the song's
     vocal pitch is compared with the reference: if the melody sits far above what the reference
     covers (a speaking voice only spans ~1 octave), it is moved down a whole octave (same key),
     because the model breaks when asked to render a timbre well outside the pitches it heard.
  3. The converted vocals are mixed back with the instrumental and encoded to MP3.

REST API (port 8002):
  GET  /health
  POST /analyze            multipart: audio, [kind=speech|singing] → pitch profile of a reference (Hz, register)
  POST /extract-reference  multipart: audio (a full song) → WAV: the cleanest 30 s of its vocal stem, to be used
                           as a *sung* reference voice (a synthetic singer that stays the same across songs)
  POST /clean-reference    multipart: audio → WAV: reference denoised (Demucs vocal stem) + de-reverb (UVR DeEcho-DeReverb)
                           + speech chain (HPF, de-ess, EQ, comp, loudnorm)
  POST /sculpt-reference   multipart: audio, [formant_pct], [pitch_st], [brightness_db] → WAV: the reference with its
                           formants (vocal-tract size), pitch median and air reshaped (Praat PSOLA, CPU); see sculpt.py
  POST /align-lyrics       multipart: audio (song), lyrics (text), [language], [model] → line/word timings of the lyrics
                           (Demucs vocal stem → faster-whisper word timestamps → aligned to the known lyrics)
  POST /enhance            multipart: audio → WAV restored with Apollo (band-split music restoration)
  POST /reference-analysis multipart: url (YouTube) | audio, [token] → JSON: what the song sounds like (tempo, key,
                           energy, structure, stems, vocals + language, CLAP genre/mood/instrument tags); see reference.py
  GET  /reference-analysis/{token} -> {stage} while an analysis with that token runs
  POST /convert            multipart: song (audio), reference (audio), [pitch_shift], [diffusion_steps], [auto_octave],
                           [autotune], [autotune_strength], [key_scale]  (autotune = the song's F0 is snapped to
                           the nearest scale note before conditioning Seed-VC, so the sung pitch comes out in tune)
  GET  /jobs/{id}          -> {status: queued|running|done|failed, stage, error, octave_shift}
  GET  /jobs/{id}/audio    -> converted MP3
"""
from __future__ import annotations

import os
import re
import sys
import shutil
import subprocess
import threading
import time
import uuid
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Optional

warnings.simplefilter("ignore")

ROOT = Path(__file__).resolve().parent
SEED_VC_DIR = ROOT / "seed-vc"
APOLLO_DIR = ROOT / "Apollo"
WORK_DIR = Path(os.environ.get("VOICE_WORK_DIR", ROOT / ".cache" / "jobs"))
WORK_DIR.mkdir(parents=True, exist_ok=True)
os.chdir(SEED_VC_DIR)  # seed-vc resolves ./checkpoints and ./configs relative to cwd
sys.path.insert(0, str(SEED_VC_DIR))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402

DEVICE = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
SR = 44100


@dataclass
class Job:
    id: str
    dir: Path
    song: Path
    reference: Path
    pitch_shift: int = 0
    diffusion_steps: int = 30
    auto_octave: bool = True
    octave_shift: int = 0  # decided per job: -12, 0 or +12 semitones
    autotune: bool = False
    autotune_strength: float = 0.8
    key_scale: str = ""  # e.g. "E major", "A minor"; empty = chromatic
    ref_kind: str = "speech"  # "singing" = the reference already sings: its own range is the comfortable range
    status: str = "queued"
    stage: str = "En cola"
    error: Optional[str] = None
    output: Optional[Path] = None
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None


jobs: dict[str, Job] = {}
queue: "Queue[Job]" = Queue()
_models_lock = threading.Lock()
_seed_vc = None
_separator = None
_apollo = None
_apollo_lock = threading.Lock()
# One heavy GPU pipeline at a time: a conversion job, a reference cleanup or an Apollo pass. Running
# Demucs + DeEcho + Seed-VC concurrently on MPS took the whole process down (killed, no traceback).
_gpu_lock = threading.Lock()


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def load_models():
    """Lazy-load Seed-VC + Demucs once (first job pays the download/load cost)."""
    global _seed_vc, _separator
    with _models_lock:
        if _seed_vc is None:
            from seed_vc_wrapper import SeedVCWrapper

            print(f"[voice] loading Seed-VC on {DEVICE}...", flush=True)
            _seed_vc = SeedVCWrapper(device=torch.device(DEVICE))
            # The wrapper compares torch.device to the string "mps" (always False) and then
            # moves float64 F0 arrays to MPS, which has no float64. Cast at the source.
            rmvpe = _seed_vc.rmvpe
            _orig_infer = rmvpe.infer_from_audio

            def _infer_f32(*args, **kwargs):
                return clean_f0(np.asarray(_orig_infer(*args, **kwargs), dtype=np.float32))

            rmvpe.infer_from_audio = _infer_f32
            print("[voice] Seed-VC ready", flush=True)
        if _separator is None:
            from demucs.api import Separator

            print("[voice] loading Demucs htdemucs...", flush=True)
            try:
                _separator = Separator(model="htdemucs", device=DEVICE, segment=7.8, progress=False)
            except Exception as exc:  # MPS fallback
                print(f"[voice] Demucs on {DEVICE} failed ({exc}); using cpu", flush=True)
                _separator = Separator(model="htdemucs", device="cpu", segment=7.8, progress=False)
            print("[voice] Demucs ready", flush=True)
    return _seed_vc, _separator


def clean_f0(f0: np.ndarray, min_island: int = 3, kernel: int = 5) -> np.ndarray:
    """Removes single-frame pitch glitches (octave errors from instrument bleed) that make the
    converted voice crack: median-filters each voiced run and drops voiced islands shorter than
    `min_island` frames (RMVPE runs at 100 frames/s). Unvoiced frames (0) are left untouched."""
    from scipy.ndimage import median_filter

    f0 = f0.copy()
    voiced = f0 > 1
    if not voiced.any():
        return f0
    edges = np.flatnonzero(np.diff(np.concatenate(([0], voiced.astype(np.int8), [0]))))
    for start, end in zip(edges[::2], edges[1::2]):
        if end - start < min_island:
            f0[start:end] = 0
        elif end - start >= kernel:
            f0[start:end] = median_filter(f0[start:end], size=kernel, mode="nearest")
    return f0


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = {"DB": 1, "EB": 3, "GB": 6, "AB": 8, "BB": 10, "CB": 11, "FB": 4}


def parse_key_scale(text: str) -> Optional[set]:
    """'E major' / 'C# minor' / 'Db major' → set of allowed pitch classes; None when unknown/empty."""
    m = re.match(r"^\s*([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\s*$", text or "")
    if not m:
        return None
    root = NOTE_NAMES.index(m.group(1).upper())
    acc = m.group(2)
    if acc in ("#", "♯"):
        root += 1
    elif acc in ("b", "♭"):
        root -= 1
    minor = (m.group(3) or "major").lower() in ("minor", "min", "m")
    steps = [0, 2, 3, 5, 7, 8, 10, 11] if minor else [0, 2, 4, 5, 7, 9, 11]  # natural minor + leading tone
    return {(root + st) % 12 for st in steps}


def autotune_f0(f0: np.ndarray, strength: float = 0.8, scale: Optional[set] = None, hop_ms: float = 10.0) -> np.ndarray:
    """Pulls each voiced frame toward the nearest allowed note (scale or chromatic). The target note is
    decided on a 70 ms median of the pitch (so vibrato and glides do not flicker between notes) and the
    correction is faded in over ~50 ms; `strength` 1.0 = hard tune, 0.5 = half-way."""
    from scipy.ndimage import median_filter, uniform_filter1d

    f0 = f0.copy()
    voiced = f0 > 1
    if voiced.sum() < 3:
        return f0
    midi = np.full_like(f0, np.nan, dtype=np.float32)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    edges = np.flatnonzero(np.diff(np.concatenate(([0], voiced.astype(np.int8), [0]))))
    for start, end in zip(edges[::2], edges[1::2]):
        seg = midi[start:end]
        k = max(1, int(round(70 / hop_ms)))
        smooth = median_filter(seg, size=min(k, len(seg)), mode="nearest") if len(seg) > 1 else seg
        target = np.round(smooth)
        if scale:
            for i, t in enumerate(target):
                if int(t) % 12 not in scale:
                    lo, hi = t, t
                    while int(lo) % 12 not in scale:
                        lo -= 1
                    while int(hi) % 12 not in scale:
                        hi += 1
                    target[i] = lo if smooth[i] - lo <= hi - smooth[i] else hi
        delta = target - seg
        w = max(1, int(round(50 / hop_ms)))
        delta = uniform_filter1d(delta, size=min(w, len(delta)), mode="nearest") if len(delta) > 1 else delta
        midi[start:end] = seg + strength * delta
    out = f0.copy()
    out[voiced] = 440.0 * 2 ** ((midi[voiced] - 69) / 12)
    return out


def hz_to_note(hz: float) -> str:
    midi = int(round(69 + 12 * np.log2(max(hz, 1e-3) / 440.0)))
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


# Register from the *speaking* median F0 (Hz). Singing comfortably reaches ~1.3 octaves above it.
REGISTERS = [(98, "bass"), (125, "baritone"), (165, "tenor"), (200, "alto"), (245, "mezzo-soprano"), (1e9, "soprano")]
RANGE_BELOW, RANGE_ABOVE = 0.8, 2.4  # comfortable singing range as multiples of the speaking median


# Sung references: the register is read from the sung median (higher than the speaking one).
SINGING_REGISTERS = [(150, "bass"), (200, "baritone"), (260, "tenor"), (330, "alto"), (400, "mezzo-soprano"), (1e9, "soprano")]
SUNG_MARGIN = 2 ** (2 / 12)  # a whole tone beyond the measured p10/p90


def register_for(median_hz: float, kind: str = "speech") -> str:
    table = SINGING_REGISTERS if kind == "singing" else REGISTERS
    return next(name for limit, name in table if median_hz < limit)


def f0_profile(voiced_hz: np.ndarray, voiced_ratio: float, kind: str = "speech") -> dict:
    p10, p50, p90 = (float(x) for x in np.percentile(voiced_hz, [10, 50, 90]))
    if kind == "singing":
        low, high = p10 / SUNG_MARGIN, p90 * SUNG_MARGIN
    else:
        low, high = p50 * RANGE_BELOW, p50 * RANGE_ABOVE
    return {
        "kind": kind,
        "median_hz": round(p50, 1),
        "p10_hz": round(p10, 1),
        "p90_hz": round(p90, 1),
        "voiced_ratio": round(float(voiced_ratio), 3),
        "median_note": hz_to_note(p50),
        "register": register_for(p50, kind),
        "sing_low_hz": round(low, 1),
        "sing_high_hz": round(high, 1),
        "sing_low_note": hz_to_note(low),
        "sing_high_note": hz_to_note(high),
    }


def timbre_metrics(y: np.ndarray, sr: int, f0: np.ndarray, voiced: np.ndarray, n_fft: int = 1024, hop: int = 256) -> dict:
    """Raw timbre/delivery descriptors over the voiced frames (labels and thresholds live in the web app):
    brightness (spectral centroid), air/noise (spectral flatness), body (low/mid band energy ratio),
    intonation span, frame-to-frame pitch movement and loudness variation."""
    import librosa

    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop)) ** 2
    n = min(S.shape[1], len(voiced))
    S, vmask = S[:, :n], voiced[:n]
    if vmask.sum() < 20:
        return {}
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    centroid = librosa.feature.spectral_centroid(S=np.sqrt(S), sr=sr, n_fft=n_fft, hop_length=hop)[0, :n]
    rolloff = librosa.feature.spectral_rolloff(S=np.sqrt(S), sr=sr, n_fft=n_fft, hop_length=hop, roll_percent=0.85)[0, :n]
    flatness = librosa.feature.spectral_flatness(S=np.sqrt(S), n_fft=n_fft, hop_length=hop)[0, :n]
    low = S[(freqs >= 80) & (freqs < 500)].sum(axis=0) + 1e-10
    mid = S[(freqs >= 500) & (freqs < 3000)].sum(axis=0) + 1e-10
    rms_db = 10 * np.log10(S.sum(axis=0) + 1e-10)
    f0v = f0[:n]
    semis = 12 * np.log2(np.where(f0v > 0, f0v, np.nan) / 55.0)
    step = np.abs(np.diff(semis))
    step = step[np.isfinite(step)]
    p10, p90 = np.nanpercentile(semis[vmask], [10, 90])
    return {
        "centroid_hz": round(float(np.mean(centroid[vmask])), 1),
        "rolloff_hz": round(float(np.mean(rolloff[vmask])), 1),
        "flatness": round(float(np.mean(flatness[vmask])), 4),
        "low_mid_db": round(float(np.mean(10 * np.log10(low[vmask] / mid[vmask]))), 2),
        "intonation_st": round(float(p90 - p10), 2),
        "pitch_step_st": round(float(np.median(step)) if len(step) else 0.0, 3),
        "rms_db_std": round(float(np.std(rms_db[vmask])), 2),
    }


def analyze_reference(path: Path, kind: str = "speech") -> dict:
    """Pitch + timbre profile of a reference (spoken or sung) with librosa's pYIN: no model load needed, ~3 s for 30 s."""
    import librosa

    y, sr = librosa.load(str(path), sr=16000, mono=True, duration=30)
    f0, voiced, prob = librosa.pyin(y, fmin=55, fmax=1100, sr=sr, frame_length=1024, hop_length=256)
    voiced = voiced & np.isfinite(f0) & (prob > 0.5) & (f0 > 60)
    if voiced.sum() >= 50:
        # Noisy recordings yield spurious frames (rumble at fmin, hiss an octave up); keep ±1 octave around the median.
        med = float(np.median(f0[voiced]))
        voiced &= (f0 > med / 2) & (f0 < med * 2)
    v = f0[voiced]
    if len(v) < 50:
        raise ValueError("No se detectó voz suficiente en la grabación")
    profile = f0_profile(v, len(v) / max(len(f0), 1), kind)
    profile["metrics"] = timbre_metrics(y, sr, np.nan_to_num(f0), voiced)
    return profile


def f0_rmvpe(path: Path, max_seconds: Optional[float] = None) -> np.ndarray:
    """Voiced F0 values (Hz) of an audio file using the RMVPE already loaded with Seed-VC."""
    import librosa

    vc, _ = load_models()
    y, _ = librosa.load(str(path), sr=16000, mono=True, duration=max_seconds)
    f0 = vc.rmvpe.infer_from_audio(torch.from_numpy(y).float().to(DEVICE), thred=0.03)
    f0 = np.asarray(f0, dtype=np.float32)
    return f0[f0 > 1]


def comfortable_range(ref_hz: np.ndarray, kind: str) -> tuple[float, float]:
    """Hz range the reference voice covers comfortably: measured (± a whole tone) when it sings,
    extrapolated from the speaking median otherwise (a speaking voice only spans ~1 octave)."""
    if kind == "singing":
        p10, p90 = (float(x) for x in np.percentile(ref_hz, [10, 90]))
        return p10 / SUNG_MARGIN, p90 * SUNG_MARGIN
    med = float(np.median(ref_hz))
    return med * RANGE_BELOW, med * RANGE_ABOVE


def choose_octave_shift(song_hz: np.ndarray, lo: float, hi: float) -> tuple[int, dict]:
    """Picks -12/0/+12 semitones so the song's melody sits inside the reference's comfortable range [lo, hi].
    Score = mean distance (in octaves) of voiced frames outside the range; 0 wins near-ties."""
    scores = {}
    for shift in (0, -12, 12):
        f = song_hz * 2 ** (shift / 12)
        outside = np.maximum(0, np.log2(lo / f)) + np.maximum(0, np.log2(f / hi))
        scores[shift] = float(np.mean(outside))
    best = min(scores, key=scores.get)
    if scores[0] <= scores[best] + 0.01:  # small hysteresis: keep the original octave on near-ties
        best = 0
    return best, scores


def separate(song_wav: Path, out_dir: Path) -> tuple[Path, Path]:
    """Returns (vocals_wav, instrumental_wav), both stereo 44.1k."""
    from demucs.api import save_audio

    _, sep = load_models()
    try:
        _, stems = sep.separate_audio_file(song_wav)
    except Exception as exc:
        if sep.device == "cpu":
            raise
        print(f"[voice] Demucs failed on {sep.device} ({exc}); retrying on cpu", flush=True)
        sep.update_parameter(device="cpu")
        _, stems = sep.separate_audio_file(song_wav)
    vocals = stems["vocals"]
    instrumental = sum(v for k, v in stems.items() if k != "vocals")
    voc_path, inst_path = out_dir / "vocals.wav", out_dir / "instrumental.wav"
    save_audio(vocals, voc_path, samplerate=sep.samplerate)
    save_audio(instrumental, inst_path, samplerate=sep.samplerate)
    return voc_path, inst_path


def convert_vocals(vocals_wav: Path, reference_wav: Path, job: Job, out_dir: Path) -> Path:
    vc, _ = load_models()
    rmvpe = vc.rmvpe
    base_infer = rmvpe.infer_from_audio
    if job.autotune:
        # Seed-VC's F0-conditioned model follows the pitch curve it is given, so tuning the curve tunes the
        # sung voice. convert_voice extracts F0 twice, reference first and then the song vocals; only the
        # second curve is corrected. Restored in `finally`, so a failed job never leaks the hook.
        scale = parse_key_scale(job.key_scale)
        calls = {"n": 0}

        def _tuned(*args, **kwargs):
            f0 = base_infer(*args, **kwargs)
            calls["n"] += 1
            return autotune_f0(f0, job.autotune_strength, scale) if calls["n"] == 2 else f0

        rmvpe.infer_from_audio = _tuned
    try:
        return _convert_vocals(vc, vocals_wav, reference_wav, job, out_dir)
    finally:
        rmvpe.infer_from_audio = base_infer


def _convert_vocals(vc, vocals_wav: Path, reference_wav: Path, job: Job, out_dir: Path) -> Path:
    # convert_voice is a generator (it contains `yield`); with stream_output=False the full
    # waveform arrives as the generator's return value, i.e. StopIteration.value.
    gen = vc.convert_voice(
        source=str(vocals_wav),
        target=str(reference_wav),
        diffusion_steps=job.diffusion_steps,
        length_adjust=1.0,
        inference_cfg_rate=0.7,
        f0_condition=True,
        auto_f0_adjust=False,  # keep the song's melody/key; only the timbre changes
        pitch_shift=job.pitch_shift + job.octave_shift,  # octaves keep the key too
        stream_output=False,
    )
    audio = None
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        audio = stop.value
    if audio is None:
        raise RuntimeError("Seed-VC returned no audio")
    audio = np.asarray(audio, dtype=np.float32).squeeze()
    out = out_dir / "vocals_converted.wav"
    sf.write(out, audio, SR)
    return out


def _stft(x: np.ndarray, n_fft: int = 2048, hop: int = 512):
    from scipy.signal import stft

    return stft(x, fs=SR, nperseg=n_fft, noverlap=n_fft - hop, padded=True, boundary="zeros")


def _smooth_log_freq(curve: np.ndarray, freqs: np.ndarray, octaves: float = 1 / 3) -> np.ndarray:
    """Smooths a per-bin curve with a window of `octaves` width (in log frequency)."""
    out = curve.copy()
    logf = np.log2(np.maximum(freqs, 20.0))
    half = octaves / 2
    for i, lf in enumerate(logf):
        m = (logf >= lf - half) & (logf <= lf + half)
        out[i] = np.mean(curve[m])
    return out


def match_spectrum(conv: np.ndarray, orig: np.ndarray, max_db: float = 8.0) -> np.ndarray:
    """EQ-matches the converted vocal (mono) to the original vocal stem's long-term spectrum, measured on
    the louder half of the frames and smoothed to 1/3 octave, so the converted voice sits in the same
    tonal place in the mix (Seed-VC output is typically darker and thinner than the stem it replaces)."""
    from scipy.signal import istft

    f, _, Zc = _stft(conv)
    _, _, Zo = _stft(orig[: len(conv)])
    n = min(Zc.shape[1], Zo.shape[1])
    Zc, Zo = Zc[:, :n], Zo[:, :n]
    e_o, e_c = np.abs(Zo).sum(axis=0), np.abs(Zc).sum(axis=0)
    loud = (e_o > np.percentile(e_o, 50)) & (e_c > np.percentile(e_c, 50))
    if loud.sum() < 20:
        return conv
    mag_o = np.abs(Zo[:, loud]).mean(axis=1) + 1e-8
    mag_c = np.abs(Zc[:, loud]).mean(axis=1) + 1e-8
    gain_db = 20 * np.log10(mag_o / mag_c)
    band = (f >= 80) & (f <= 12000)
    gain_db[~band] = 0
    gain_db = np.clip(_smooth_log_freq(gain_db, f), -max_db, max_db)
    gain_db[f < 60] = 0
    Zc = Zc * (10 ** (gain_db / 20))[:, None]
    _, y = istft(Zc, fs=SR, nperseg=2048, noverlap=2048 - 512)
    y = np.asarray(y, dtype=np.float32)
    return np.pad(y, (0, max(0, len(conv) - len(y))))[: len(conv)]


def match_envelope(conv: np.ndarray, orig: np.ndarray, win_ms: float = 120.0, max_up_db: float = 6.0, max_down_db: float = 18.0) -> np.ndarray:
    """Makes the converted vocal follow the original vocal's loudness envelope (same timing, since Seed-VC
    keeps the length): phrase dynamics, fades and the silences between lines come back, which is most of
    what makes a vocal feel mixed rather than pasted on top."""
    from scipy.ndimage import uniform_filter1d

    win = int(SR * win_ms / 1000)
    env = lambda x: np.sqrt(uniform_filter1d(x.astype(np.float64) ** 2, size=win, mode="nearest")) + 1e-6  # noqa: E731
    n = min(len(conv), len(orig))
    ratio = env(orig[:n]) / env(conv[:n])
    ratio = np.clip(ratio, 10 ** (-max_down_db / 20), 10 ** (max_up_db / 20))
    ratio = uniform_filter1d(ratio, size=win // 2, mode="nearest")
    out = conv.copy()
    out[:n] = conv[:n] * ratio
    return out.astype(np.float32)


def measure_reverb_db(vocals_wav: Path, work: Path, seconds: float = 60.0) -> float:
    """Wet/dry level (dB) of the original vocal stem, from UVR DeEcho-DeReverb on its first `seconds`."""
    clip = work / "orig_head.wav"
    x, _ = sf.read(vocals_wav, dtype="float32", always_2d=True)
    sf.write(clip, x[: int(SR * seconds)], SR)
    return dereverb_file(clip, work / "orig_head_dry.wav", work)


def add_reverb(voc: np.ndarray, wet_db: float, rt60: float = 1.6, predelay_ms: float = 25.0) -> np.ndarray:
    """Stereo synthetic reverb (decaying noise IR, band-limited 250 Hz–7 kHz) at `wet_db` below the dry vocal."""
    from scipy.signal import butter, fftconvolve, sosfilt

    rng = np.random.default_rng(7)
    n_ir = int(SR * rt60)
    t = np.arange(n_ir) / SR
    decay = np.exp(-6.91 * t / rt60)  # -60 dB at rt60
    sos = butter(2, [250, 7000], btype="band", fs=SR, output="sos")
    ir = np.stack([sosfilt(sos, rng.standard_normal(n_ir) * decay) for _ in range(2)], axis=1).astype(np.float32)
    pre = np.zeros((int(SR * predelay_ms / 1000), 2), dtype=np.float32)
    ir = np.concatenate([pre, ir])
    dry = voc.mean(axis=1)
    wet = np.stack([fftconvolve(dry, ir[:, c])[: len(voc)] for c in range(2)], axis=1)
    rms = lambda x: float(np.sqrt(np.mean(np.square(x))) + 1e-8)  # noqa: E731
    wet *= (rms(voc) * 10 ** (wet_db / 20)) / rms(wet)
    return voc + wet.astype(np.float32)


def mix(vocals_wav: Path, instrumental_wav: Path, out_mp3: Path) -> None:
    """Mixes the converted vocal back, glued to the space of the original vocal stem:
    spectral match → loudness-envelope match → reverb at the original's measured wet level → sum."""
    voc, sr_v = sf.read(vocals_wav, dtype="float32", always_2d=True)
    inst, sr_i = sf.read(instrumental_wav, dtype="float32", always_2d=True)
    assert sr_v == SR and sr_i == SR, (sr_v, sr_i)
    orig, _ = sf.read(vocals_wav.parent / "vocals.wav", dtype="float32", always_2d=True)
    orig_mono = orig.mean(axis=1)
    mono = voc.mean(axis=1)
    try:
        mono = match_spectrum(mono, orig_mono)
        mono = match_envelope(mono, orig_mono)
    except Exception as exc:  # noqa: BLE001  (glue is best effort; the plain mix still works)
        print(f"[voice] mix glue skipped: {exc}", flush=True)
    voc = np.repeat(mono[:, None], 2, axis=1)
    try:
        wet_db = measure_reverb_db(vocals_wav.parent / "vocals.wav", vocals_wav.parent)
        wet_db = float(np.clip(wet_db, -24.0, -8.0))
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] reverb measurement failed ({exc}); using -14 dB", flush=True)
        wet_db = -14.0
    print(f"[voice] mix glue: reverb {wet_db:.1f} dB", flush=True)
    voc = add_reverb(voc, wet_db)
    n = max(len(voc), len(inst))
    voc = np.pad(voc, ((0, n - len(voc)), (0, 0)))
    inst = np.pad(inst, ((0, n - len(inst)), (0, 0)))
    # Final safety: overall level of the vocal equal to the original stem (envelope match already did most of it).
    rms = lambda x: float(np.sqrt(np.mean(np.square(x))) + 1e-8)  # noqa: E731
    voc = voc * float(np.clip(rms(orig) / rms(voc), 0.5, 2.0))
    mixed = voc + inst
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.98:
        mixed = mixed * (0.98 / peak)
    tmp = out_mp3.with_suffix(".mix.wav")
    sf.write(tmp, mixed, SR)
    ffmpeg("-i", str(tmp), "-codec:a", "libmp3lame", "-b:a", "192k", str(out_mp3))
    tmp.unlink(missing_ok=True)


def run_job(job: Job) -> None:
    job.status, job.stage = "running", "Esperando GPU"
    with _gpu_lock:
        _run_job(job)


def _run_job(job: Job) -> None:
    job.stage = "Cargando modelos"
    try:
        load_models()
        song_wav = job.dir / "song.wav"
        ref_wav = job.dir / "reference.wav"
        job.stage = "Preparando audio"
        ffmpeg("-i", str(job.song), "-ac", "2", "-ar", str(SR), str(song_wav))
        ffmpeg("-i", str(job.reference), "-ac", "1", "-ar", str(SR), "-t", "30", str(ref_wav))
        job.stage = "Separando voz e instrumental"
        vocals, instrumental = separate(song_wav, job.dir)
        if job.auto_octave:
            job.stage = "Comparando el tono de la canción con tu voz"
            try:
                ref_hz, song_hz = f0_rmvpe(ref_wav), f0_rmvpe(vocals)
                if len(ref_hz) > 50 and len(song_hz) > 50:
                    lo, hi = comfortable_range(ref_hz, job.ref_kind)
                    if job.ref_kind == "singing":
                        # A sung reference already covers its own range: only move the melody when it sits a
                        # whole octave away from where that singer sings (median vs median). The range score is
                        # too easily fooled by octave errors of the pitch tracker on backing vocals/harmonies.
                        octaves = float(np.log2(np.median(ref_hz) / np.median(song_hz)))
                        job.octave_shift = int(np.clip(round(octaves), -1, 1)) * 12
                        scores = {"median_octaves": round(octaves, 2)}
                    else:
                        job.octave_shift, scores = choose_octave_shift(song_hz, lo, hi)
                    print(
                        f"[voice] ref ({job.ref_kind}) median {np.median(ref_hz):.0f} Hz, comfortable {lo:.0f}–{hi:.0f} Hz; song vocal median "
                        f"{np.median(song_hz):.0f} Hz p90 {np.percentile(song_hz, 90):.0f} Hz → octave shift {job.octave_shift} {scores}",
                        flush=True,
                    )
            except Exception as exc:  # noqa: BLE001  (analysis is best effort)
                print(f"[voice] octave analysis failed: {exc}", flush=True)
        notes = [{-12: "melodía una octava abajo", 12: "melodía una octava arriba"}.get(job.octave_shift, ""), "afinada" if job.autotune else ""]
        job.stage = "Convirtiendo la voz a tu timbre" + (f" ({', '.join(n for n in notes if n)})" if any(notes) else "")
        converted = convert_vocals(vocals, ref_wav, job, job.dir)
        job.stage = "Mezclando"
        out = job.dir / "output.mp3"
        mix(converted, instrumental, out)
        job.output, job.status, job.stage = out, "done", "Listo"
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        job.status, job.error, job.stage = "failed", f"{type(exc).__name__}: {exc}", "Error"
    finally:
        job.finished_at = time.time()
        for p in ("song.wav", "vocals.wav", "instrumental.wav", "vocals_converted.wav"):
            (job.dir / p).unlink(missing_ok=True)


def load_apollo():
    """Apollo (JusperLee) music restoration model, loaded once on first use."""
    global _apollo
    with _apollo_lock:
        if _apollo is None:
            if str(APOLLO_DIR) not in sys.path:
                sys.path.insert(0, str(APOLLO_DIR))
            import look2hear.models  # noqa: F401  (registers BaseModel subclasses)
            from huggingface_hub import hf_hub_download

            print("[voice] loading Apollo...", flush=True)
            ckpt = hf_hub_download(repo_id="JusperLee/Apollo", filename="pytorch_model.bin")
            model = look2hear.models.BaseModel.from_pretrain(ckpt, sr=44100, win=20, feature_dim=256, layer=6)
            _apollo = model.to(DEVICE).eval()
            print("[voice] Apollo ready", flush=True)
    return _apollo


def enhance_file(in_wav: Path, out_wav: Path) -> None:
    """Runs Apollo over a 44.1 kHz stereo WAV with padded, overlapped chunks (bounded memory)."""
    import importlib.util

    model = load_apollo()  # also puts the Apollo repo (look2hear) on sys.path
    spec = importlib.util.spec_from_file_location("apollo_inference", APOLLO_DIR / "inference.py")
    inf = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(inf)
    audio, sample_rate = inf.load_audio(in_wav)
    chunk, overlap, pad = inf.resolve_chunking(6.0, 1.0, 1.0)
    with torch.inference_mode():
        out = inf.run_model(model, audio, torch.device(DEVICE), chunk_samples=chunk, overlap_samples=overlap, chunk_batch_size=2, chunk_pad_samples=pad)
    inf.save_audio(out_wav, out, sample_rate)


def worker() -> None:
    while True:
        job = queue.get()
        run_job(job)
        queue.task_done()


threading.Thread(target=worker, daemon=True).start()

app = FastAPI(title="Suno Local voice service")


@app.get("/health")
def health():
    return {"status": "ok", "device": DEVICE, "models_loaded": _seed_vc is not None, "apollo_loaded": _apollo is not None, "queued": queue.qsize()}


@app.post("/analyze")
def analyze(audio: UploadFile = File(...), kind: str = Form("speech")):
    """Pitch profile of a reference recording (speaking voice): median/percentiles in Hz, register and
    the comfortable singing range derived from it. Runs in FastAPI's threadpool, no GPU model needed."""
    job_dir = WORK_DIR / f"analyze-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"upload{Path(audio.filename or 'in.wav').suffix or '.wav'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    try:
        wav = job_dir / "ref16k.wav"
        ffmpeg("-i", str(src), "-ac", "1", "-ar", "16000", "-t", "30", str(wav))
        return analyze_reference(wav, "singing" if kind == "singing" else "speech")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


UVR_DIR = ROOT / ".cache" / "uvr"
_uvr_lock = threading.Lock()


def dereverb_file(in_wav: Path, out_wav: Path, work: Path) -> float:
    """Removes room reverb/echo with UVR's DeEcho-DeReverb model (audio-separator). Returns the level of the
    removed reverb in dB relative to the input (≈ -60 dB means the recording was already dry)."""
    from audio_separator.separator import Separator

    with _uvr_lock:
        sep = Separator(output_dir=str(work), model_file_dir=str(UVR_DIR), log_level=40)
        sep.load_model(model_filename="UVR-DeEcho-DeReverb.pth")
        outs = sep.separate(str(in_wav))
    dry = next((work / f for f in outs if "(No Reverb)" in f), None)
    wet = next((work / f for f in outs if "(Reverb)" in f and "(No Reverb)" not in f), None)
    if dry is None:
        raise RuntimeError("DeEcho-DeReverb produced no output")
    d, _ = sf.read(dry, dtype="float32", always_2d=True)
    sf.write(out_wav, d.mean(axis=1), SR)
    x, _ = sf.read(in_wav, dtype="float32", always_2d=True)
    rms = lambda a: float(np.sqrt(np.mean(a**2)) + 1e-9)  # noqa: E731
    if wet is None:
        return -99.0
    w, _ = sf.read(wet, dtype="float32", always_2d=True)
    return round(float(20 * np.log10(rms(w) / rms(x))), 1)


def clean_reference_file(src: Path, out_wav: Path, work: Path) -> dict:
    """Studio-style cleanup of a spoken reference:
    1. Demucs htdemucs keeps only the vocal stem (drops room noise, hum, music, keyboard clicks). Skipped
       when it would throw away too much of the signal (i.e. the recording was already clean speech).
    2. UVR DeEcho-DeReverb removes room reverb/echo (the timbre the conversion model learns must be dry).
    3. ffmpeg speech chain: high-pass 80 Hz, FFT denoise, de-esser, gentle EQ (less mud, more presence),
       compression, loudness normalisation to -18 LUFS. Returns simple before/after numbers."""
    wav_in = work / "ref44.wav"
    ffmpeg("-i", str(src), "-ac", "1", "-ar", str(SR), "-t", "30", str(wav_in))
    x, _ = sf.read(wav_in, dtype="float32")
    rms_in = float(np.sqrt(np.mean(x**2)) + 1e-9)
    stem_in = wav_in
    demucs_used = False
    try:
        vocals, _ = separate(wav_in, work)
        v, _ = sf.read(vocals, dtype="float32", always_2d=True)
        v = v.mean(axis=1)
        keep = float(np.sqrt(np.mean(v**2)) + 1e-9) / rms_in
        if keep > 0.5:
            sf.write(work / "vocals_mono.wav", v, SR)
            stem_in = work / "vocals_mono.wav"
            demucs_used = True
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] clean-reference: Demucs skipped ({exc})", flush=True)
    reverb_db: Optional[float] = None
    try:
        dry = work / "dry.wav"
        reverb_db = dereverb_file(stem_in, dry, work)
        stem_in = dry
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] clean-reference: de-reverb skipped ({exc})", flush=True)
    floor = lambda a: float(20 * np.log10(np.percentile(np.abs(a) + 1e-9, 10)))  # noqa: E731  (quiet-frame level)
    noisy = floor(x) > -55  # cheap mics without the browser's noise suppression sit around -45 dB
    # Non-local-means keeps the consonants/air that FFT gating strips (measured: same floor, +4 dB of 3–7 kHz kept).
    denoise = "anlmdn=s=7:p=0.002:r=0.006,afftdn=nf=-30:nt=w" if noisy else "afftdn=nf=-30:nt=w"
    dull = hi_mid_db(x) < -13  # far from the mic / muffled capture: give the presence band back
    chain = ",".join([
        "highpass=f=80",
        denoise,
        "deesser=i=0.12",  # measured: i=0.4 cost 9 dB of 3-7 kHz (the voice came out muffled)
        "equalizer=f=250:t=q:w=1.2:g=-2",
        "equalizer=f=3200:t=q:w=1.0:g=2",
        "highshelf=f=5000:g=2" if demucs_used else "highshelf=f=5000:g=0.5",  # Demucs' vocal stem loses ~2 dB of air
        *(["highshelf=f=4000:g=3"] if dull else []),
        "acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=2",
        "loudnorm=I=-18:TP=-1.5:LRA=9",
    ])
    ffmpeg("-i", str(stem_in), "-af", chain, "-ac", "1", "-ar", str(SR), str(out_wav))
    y, _ = sf.read(out_wav, dtype="float32")
    return {
        "demucs": demucs_used,
        "reverb_removed_db": reverb_db,
        "strong_denoise": noisy,
        "presence_boost": dull,
        "noise_floor_before_db": round(floor(x), 1),
        "noise_floor_after_db": round(floor(y), 1),
        "hi_mid_before_db": round(hi_mid_db(x), 1),
        "hi_mid_after_db": round(hi_mid_db(y), 1),
    }


def hi_mid_db(y: np.ndarray, sr: int = SR) -> float:
    """Energy 3–7 kHz vs 0.3–3 kHz on the louder half of the frames: presence/air of a voice recording
    (a close, bright capture sits around -8 dB; far or muffled ones below -14 dB)."""
    import librosa

    S = np.abs(librosa.stft(y.astype(np.float32), n_fft=2048, hop_length=512)) ** 2
    f = librosa.fft_frequencies(sr=sr, n_fft=2048)
    level = 10 * np.log10(S.sum(axis=0) + 1e-12)
    loud = level > np.percentile(level, 60)
    hi = S[(f >= 3000) & (f < 7000)][:, loud].sum()
    mid = S[(f >= 300) & (f < 3000)][:, loud].sum()
    return float(10 * np.log10((hi + 1e-12) / (mid + 1e-12)))


def best_vocal_window(vocals: np.ndarray, seconds: float = 30.0, hop_s: float = 0.5) -> tuple[int, int, float]:
    """Start/end samples of the `seconds` window of a vocal stem with the most sung material: highest
    fraction of 50 ms frames above the loud threshold, tie-broken by energy. Returns (start, end, density)."""
    frame = int(SR * 0.05)
    env = np.array([np.sqrt(np.mean(vocals[i : i + frame] ** 2)) for i in range(0, len(vocals) - frame, frame)]) + 1e-9
    db = 20 * np.log10(env)
    thr = np.percentile(db, 90) - 25
    active = (db > thr).astype(np.float32)
    win = int(seconds / 0.05)
    if len(active) <= win:
        return 0, len(vocals), float(active.mean())
    hop = max(1, int(hop_s / 0.05))
    best, best_score = 0, -1.0
    for i in range(0, len(active) - win, hop):
        score = active[i : i + win].mean() + 0.001 * db[i : i + win].mean() / 100
        if score > best_score:
            best, best_score = i, score
    return best * frame, (best + win) * frame, float(active[best : best + win].mean())


def extract_reference_file(src: Path, out_wav: Path, work: Path, seconds: float = 30.0) -> dict:
    """Builds a sung reference from a full song: Demucs vocal stem → densest `seconds` window → light
    speech chain (no heavy denoise: the stem is already clean) → loudnorm. Mono 44.1 kHz WAV."""
    song = work / "song44.wav"
    ffmpeg("-i", str(src), "-ac", "2", "-ar", str(SR), str(song))
    vocals, _ = separate(song, work)
    v, _ = sf.read(vocals, dtype="float32", always_2d=True)
    mono = v.mean(axis=1)
    start, end, density = best_vocal_window(mono, seconds)
    sf.write(work / "window.wav", mono[start:end], SR)
    chain = "highpass=f=70,deesser=i=0.1,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=150:makeup=1,loudnorm=I=-18:TP=-1.5:LRA=11"
    ffmpeg("-i", str(work / "window.wav"), "-af", chain, "-ac", "1", "-ar", str(SR), str(out_wav))
    return {"start_sec": round(start / SR, 1), "end_sec": round(end / SR, 1), "sung_density": round(density, 3)}


@app.post("/extract-reference")
def extract_reference(audio: UploadFile = File(...), seconds: float = Form(30.0)):
    """The best `seconds` of a song's vocals as a mono WAV (a reusable synthetic singer). Stats in X-Extract-Info."""
    import json

    job_dir = WORK_DIR / f"extract-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"upload{Path(audio.filename or 'song.mp3').suffix or '.mp3'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    out = job_dir / "reference.wav"
    try:
        load_models()
        with _gpu_lock:
            info = extract_reference_file(src, out, job_dir, max(10.0, min(seconds, 30.0)))
        data = out.read_bytes()
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
    from fastapi.responses import Response

    return Response(content=data, media_type="audio/wav", headers={"X-Extract-Info": json.dumps(info)})


# ---------------------------------------------------------------------------------------------------
# Lyrics alignment (for on-screen lyrics / karaoke in the videos)
# ---------------------------------------------------------------------------------------------------
_whisper = None
_whisper_name = ""


def load_whisper(name: str):
    global _whisper, _whisper_name
    if _whisper is None or _whisper_name != name:
        from faster_whisper import WhisperModel

        print(f"[voice] loading faster-whisper {name}...", flush=True)
        _whisper = WhisperModel(name, device="cpu", compute_type="int8")
        _whisper_name = name
    return _whisper


def _norm_token(w: str) -> str:
    import unicodedata

    w = unicodedata.normalize("NFD", w.lower())
    w = "".join(c for c in w if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9ñ]+", "", w)


def align_lyrics(vocals_wav: Path, lyrics: str, language: str = "es", model: str = "medium", duration: float = 0.0) -> dict:
    """Times each lyric line (and word) against the sung vocals.
    1. faster-whisper transcribes the vocal stem with word timestamps (singing is noisy: we never trust
       the words themselves, only their times).
    2. The transcribed words are aligned to the known lyrics (difflib on normalised tokens); matched words
       anchor the timeline, the rest is interpolated between anchors so every line and word gets a time.
    Returns {"lines": [{"text", "start", "end", "words": [{"text","start","end"}], "matched"}], "confidence"}."""
    import difflib

    wm = load_whisper(model)
    # The lyrics as prompt bias the decoder toward the real words (singing is otherwise half-heard).
    prompt = " ".join(ln.strip() for ln in lyrics.splitlines() if ln.strip() and not ln.strip().startswith("["))[:600]
    segments, _info = wm.transcribe(str(vocals_wav), language=language, word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False, initial_prompt=prompt)
    heard: list[tuple[str, float, float]] = []
    for seg in segments:
        for w in seg.words or []:
            tok = _norm_token(w.word)
            if tok:
                heard.append((tok, float(w.start), float(w.end)))
    lines_raw = [ln.strip() for ln in lyrics.splitlines()]
    lines = [ln for ln in lines_raw if ln and not re.match(r"^\[.*\]$", ln)]
    words: list[dict] = []  # flat list of lyric words with (line index)
    for li, ln in enumerate(lines):
        for raw in ln.split():
            tok = _norm_token(raw)
            if tok:
                words.append({"text": raw, "tok": tok, "line": li, "start": None, "end": None})
    if not words or not heard:
        raise ValueError("No hay letra o no se detectó voz cantada")
    sm = difflib.SequenceMatcher(None, [w["tok"] for w in words], [h[0] for h in heard], autojunk=False)
    matched = 0
    # Only runs of >= 2 consecutive matching words anchor the timeline: a lone word ("herida") matched to the
    # wrong repetition of a chorus dragged whole lines 30 s off.
    for a, b, n in sm.get_matching_blocks():
        if n < 2:
            continue
        for k in range(n):
            words[a + k]["start"], words[a + k]["end"] = heard[b + k][1], heard[b + k][2]
            matched += 1
    # Drop anchors that break monotonic time (an anchor later in the lyrics must not be earlier in the audio).
    last = -1.0
    for w in words:
        if w["start"] is None:
            continue
        if w["start"] < last - 0.2:
            w["start"] = w["end"] = None
            matched -= 1
        else:
            last = w["end"]
    confidence = matched / len(words)
    # interpolate unmatched words between the nearest anchors (monotonic timeline)
    anchors = [i for i, w in enumerate(words) if w["start"] is not None]
    if not anchors:
        raise ValueError("La letra no coincide con lo que se oye")
    total_end = max(duration - 0.5, max(h[2] for h in heard)) if duration else max(h[2] for h in heard)
    for i, w in enumerate(words):
        if w["start"] is not None:
            continue
        prev = max((a for a in anchors if a < i), default=None)
        nxt = min((a for a in anchors if a > i), default=None)
        t0 = words[prev]["end"] if prev is not None else 0.0
        t1 = words[nxt]["start"] if nxt is not None else min(total_end, t0 + 0.45 * (len(words) - (prev if prev is not None else 0)))
        span_lo = (prev + 1) if prev is not None else 0
        span_hi = (nxt - 1) if nxt is not None else len(words) - 1
        cnt = span_hi - span_lo + 1
        slot = (t1 - t0) / max(cnt, 1)
        w["start"], w["end"] = t0 + slot * (i - span_lo), t0 + slot * (i - span_lo + 1)
    # monotonic + minimum durations
    t = 0.0
    for w in words:
        w["start"] = max(w["start"], t)
        w["end"] = max(w["end"], w["start"] + 0.12)
        t = w["end"]
    out_lines = []
    for li, ln in enumerate(lines):
        ws = [w for w in words if w["line"] == li]
        if not ws:
            continue
        # A sung line rarely exceeds ~0.9 s per word; longer spans are a gap before the next anchor.
        cap = ws[0]["start"] + max(2.5, 0.9 * len(ws) + 1.0)
        if ws[-1]["end"] > cap:
            span = cap - ws[0]["start"]
            slot = span / len(ws)
            for k, w in enumerate(ws):
                w["start"], w["end"] = ws[0]["start"] + slot * k, ws[0]["start"] + slot * (k + 1)
        out_lines.append({
            "text": ln,
            "start": round(ws[0]["start"], 3),
            "end": round(ws[-1]["end"], 3),
            "matched": round(sum(1 for w in ws if w.get("tok") and any(h[0] == w["tok"] for h in heard)) / len(ws), 2),
            "words": [{"text": w["text"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in ws],
        })
    # lines must not overlap; a line ends at the latest just before the next one starts
    for a, b in zip(out_lines, out_lines[1:]):
        if a["end"] > b["start"]:
            a["end"] = max(a["start"] + 0.3, b["start"] - 0.05)
    return {"lines": out_lines, "confidence": round(confidence, 3), "heard_words": len(heard), "lyric_words": len(words)}


@app.post("/align-lyrics")
def align_lyrics_endpoint(audio: UploadFile = File(...), lyrics: str = Form(...), language: str = Form("es"), model: str = Form("medium"), duration: float = Form(0.0)):
    job_dir = WORK_DIR / f"align-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"upload{Path(audio.filename or 'song.mp3').suffix or '.mp3'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    try:
        song = job_dir / "song44.wav"
        ffmpeg("-i", str(src), "-ac", "2", "-ar", str(SR), str(song))
        load_models()
        with _gpu_lock:
            vocals, _ = separate(song, job_dir)
            mono = job_dir / "vocals16.wav"
            ffmpeg("-i", str(vocals), "-ac", "1", "-ar", "16000", str(mono))
            return align_lyrics(mono, lyrics, language, model if model in ("tiny", "base", "small", "medium") else "medium", duration)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


@app.post("/clean-reference")
def clean_reference(audio: UploadFile = File(...)):
    """Returns the cleaned reference as WAV (mono 44.1 kHz); stats in the X-Clean-Info header (JSON)."""
    import json

    job_dir = WORK_DIR / f"clean-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"upload{Path(audio.filename or 'in.wav').suffix or '.wav'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    out = job_dir / "clean.wav"
    try:
        load_models()
        with _gpu_lock:
            info = clean_reference_file(src, out, job_dir)
        data = out.read_bytes()
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
    from fastapi.responses import Response

    return Response(content=data, media_type="audio/wav", headers={"X-Clean-Info": json.dumps(info)})


@app.post("/sculpt-reference")
def sculpt_reference(
    audio: UploadFile = File(...),
    formant_pct: float = Form(0.0),
    pitch_st: float = Form(0.0),
    brightness_db: float = Form(0.0),
):
    """Reshapes the timbre of a reference (formants, pitch median, air) → WAV mono 44.1 kHz; measurements in the
    X-Sculpt-Info header (JSON). CPU only (Praat PSOLA): no GPU lock, runs in FastAPI's threadpool."""
    import json

    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from sculpt import sculpt_file

    job_dir = WORK_DIR / f"sculpt-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"upload{Path(audio.filename or 'in.wav').suffix or '.wav'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    out = job_dir / "sculpt.wav"
    try:
        info = sculpt_file(src, out, formant_pct, pitch_st, brightness_db)
        data = out.read_bytes()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
    from fastapi.responses import Response

    return Response(content=data, media_type="audio/wav", headers={"X-Sculpt-Info": json.dumps(info)})


@app.post("/enhance")
def enhance(audio: UploadFile = File(...)):
    """AI restoration of a full mix (runs in FastAPI's threadpool). Returns WAV (44.1 kHz stereo)."""
    job_dir = WORK_DIR / f"enhance-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    src = job_dir / f"in{Path(audio.filename or 'in.mp3').suffix or '.mp3'}"
    with src.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    wav_in, wav_out = job_dir / "in.wav", job_dir / "out.wav"
    try:
        ffmpeg("-i", str(src), "-ac", "2", "-ar", str(SR), str(wav_in))
        with _gpu_lock:  # one heavy pipeline at a time on the GPU
            enhance_file(wav_in, wav_out)
        data = wav_out.read_bytes()
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
    from fastapi.responses import Response

    return Response(content=data, media_type="audio/wav")


_reference_progress: dict[str, str] = {}


@app.post("/reference-analysis")
def reference_analysis(url: str = Form(""), audio: Optional[UploadFile] = File(None), token: str = Form("")):
    """Measures a reference song (YouTube URL or uploaded audio) so the web can write a style prompt from
    it. Heavy part (Demucs + CLAP) runs under the GPU lock; ~1-3 min per song."""
    import reference

    if not url and audio is None:
        raise HTTPException(422, "Falta la URL o el audio")
    job_dir = WORK_DIR / f"reference-{uuid.uuid4()}"
    job_dir.mkdir(parents=True)
    key = token or job_dir.name

    def progress(stage: str) -> None:
        _reference_progress[key] = stage
        print(f"[reference] {stage}", flush=True)

    try:
        if audio is not None:
            source = job_dir / f"upload{Path(audio.filename or 'in.mp3').suffix or '.mp3'}"
            with source.open("wb") as f:
                shutil.copyfileobj(audio.file, f)
            source = str(source)
        else:
            source = url.strip()
        progress("En cola: esperando la GPU" if _gpu_lock.locked() else "Preparando")
        with _gpu_lock:
            _, sep = load_models()
            return reference.analyze_reference_source(source, job_dir, sep, DEVICE, progress)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        _reference_progress.pop(key, None)
        shutil.rmtree(job_dir, ignore_errors=True)


@app.get("/reference-analysis/{token}")
def reference_progress(token: str):
    return {"stage": _reference_progress.get(token)}


@app.post("/convert")
async def convert(
    song: UploadFile = File(...),
    reference: UploadFile = File(...),
    pitch_shift: int = Form(0),
    diffusion_steps: int = Form(30),
    auto_octave: bool = Form(True),
    autotune: bool = Form(False),
    autotune_strength: float = Form(0.8),
    key_scale: str = Form(""),
    ref_kind: str = Form("speech"),
):
    job_id = str(uuid.uuid4())
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True)
    song_path = job_dir / f"song_in{Path(song.filename or 'song.mp3').suffix or '.mp3'}"
    ref_path = job_dir / f"ref_in{Path(reference.filename or 'ref.wav').suffix or '.wav'}"
    with song_path.open("wb") as f:
        shutil.copyfileobj(song.file, f)
    with ref_path.open("wb") as f:
        shutil.copyfileobj(reference.file, f)
    job = Job(id=job_id, dir=job_dir, song=song_path, reference=ref_path, pitch_shift=pitch_shift, diffusion_steps=max(5, min(diffusion_steps, 100)), auto_octave=auto_octave, autotune=autotune, autotune_strength=max(0.0, min(autotune_strength, 1.0)), key_scale=key_scale, ref_kind="singing" if ref_kind == "singing" else "speech")
    jobs[job_id] = job
    queue.put(job)
    return {"job_id": job_id, "status": job.status, "queue_position": queue.qsize()}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {"job_id": job.id, "status": job.status, "stage": job.stage, "error": job.error, "octave_shift": job.octave_shift, "autotune": job.autotune}


@app.get("/jobs/{job_id}/audio")
def job_audio(job_id: str):
    job = jobs.get(job_id)
    if not job or job.status != "done" or not job.output:
        raise HTTPException(404, "audio not ready")
    return FileResponse(job.output, media_type="audio/mpeg", filename="converted.mp3")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("VOICE_HOST", "127.0.0.1"), port=int(os.environ.get("VOICE_PORT", "8002")))
