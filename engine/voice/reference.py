"""Music reference analysis: what a YouTube video (or an audio file) sounds like, in the terms a
music generation model understands — genre, mood, instruments, vocals, tempo, key, energy, structure.

Pipeline (see `analyze_reference_source`):
  1. yt-dlp downloads the best audio track (plus title, channel, tags and description).
  2. librosa measures tempo, key (Krumhansl profiles on CQT chroma), loudness, dynamics, brightness,
     onset density, the energy curve and a coarse section map (agglomerative segmentation).
  3. Demucs (htdemucs) splits drums / bass / other / vocals: how much of the mix each one carries,
     whether there are vocals, how much of the song is sung, and the sung pitch profile (register).
  4. CLAP (laion/larger_clap_music_and_speech) zero-shot tags several 10 s windows against curated
     vocabularies of genres, moods, instruments, vocal styles and production. Instruments are scored
     on the instrumental mix (no vocals to confuse them); vocal style on the vocal stem.
  5. faster-whisper (small, CPU) detects the sung language and transcribes a snippet from the most
     vocal 30 s so the caller knows what the song is about.

The service composes the style prompt from this JSON (with Ollama or deterministically); this module
only measures. Standalone: `python reference.py <url-or-file>` prints the analysis.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf

MAX_SECONDS = 600  # longer than this is a mix or a podcast, not a song
SR = 44100
ANALYSIS_SR = 22050
CLAP_SR = 48000
CLAP_MODEL = "laion/larger_clap_music_and_speech"
CLAP_WINDOWS = 8  # 10 s windows spread across the song
CLAP_WINDOW_S = 10.0

# Sung median → register (same table the voice service uses for sung references).
SINGING_REGISTERS = [(150, "bass"), (200, "baritone"), (260, "tenor"), (330, "alto"), (400, "mezzo-soprano"), (1e9, "soprano")]

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Schmuckler key profiles (major, minor).
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Zero-shot vocabularies. Kept in the model's language (English); the web turns them into prompt tags.
GENRES = [
    "pop", "synth pop", "electropop", "dance pop", "indie pop", "dream pop", "k-pop", "j-pop", "city pop",
    "rock", "indie rock", "alternative rock", "classic rock", "hard rock", "punk rock", "pop punk", "grunge", "shoegaze", "emo", "psychedelic rock", "progressive rock",
    "heavy metal", "metalcore", "nu metal",
    "hip hop", "boom bap hip hop", "trap", "drill", "r&b", "neo soul", "soul", "funk", "disco", "gospel",
    "house", "deep house", "tech house", "techno", "trance", "drum and bass", "dubstep", "edm", "future bass", "synthwave", "lo-fi hip hop", "ambient", "downtempo", "trip hop",
    "jazz", "smooth jazz", "swing", "blues", "country", "folk", "indie folk", "acoustic singer-songwriter", "bluegrass",
    "reggae", "dancehall", "afrobeats", "amapiano",
    "reggaeton", "latin trap", "dembow", "latin pop", "bachata", "salsa", "cumbia", "vallenato", "merengue", "bolero", "ranchera", "mariachi", "regional mexican", "corridos tumbados", "banda", "norteño", "flamenco", "tango", "bossa nova", "samba", "brazilian funk", "latin rock", "latin ballad",
    "classical", "orchestral", "cinematic", "opera", "musical theatre", "chillout", "new age", "children's music", "christmas music",
]
MOODS = ["happy", "sad", "melancholic", "romantic", "nostalgic", "energetic", "chill", "relaxed", "dark", "aggressive", "dreamy", "euphoric", "epic", "uplifting", "sensual", "playful", "angry", "hopeful", "tense", "mysterious", "groovy", "festive", "intimate", "anthemic", "bittersweet", "peaceful", "triumphant", "heartbroken"]
# Instruments are scored per Demucs stem: melodic/harmonic ones on "other", percussion on "drums",
# the bass type on "bass". Scoring the full mix let one loud element (a cuatro, a sax) take every window.
MELODIC = [
    "acoustic guitar", "electric guitar", "distorted electric guitar", "spanish guitar", "piano", "electric piano", "organ", "church organ",
    "synthesizer lead", "synth pads", "arpeggiated synths", "strings", "violin", "cello", "brass section", "trumpet", "trombone", "saxophone", "flute", "clarinet",
    "accordion", "harmonica", "marimba", "harp", "ukulele", "banjo", "mandolin", "charango", "bandoneón", "steel drums", "vibraphone", "bells", "choir", "orchestra", "vocal chops", "turntable scratching",
]
PERCUSSION = ["drum kit", "electronic drums", "808 drums", "drum machine", "reggaeton dembow beat", "hand percussion", "congas", "bongos", "timbales", "güiro", "cajón", "shakers", "tambourine", "hip hop boom bap drums", "four on the floor house drums", "brushed jazz drums"]
BASS = ["bass guitar", "synth bass", "808 bass", "sub bass", "upright bass"]
INSTRUMENTS = MELODIC + PERCUSSION + BASS
VOCALS = ["male vocals", "female vocals", "a male and female duet", "rap vocals", "autotuned vocals", "whispered vocals", "screaming vocals", "falsetto vocals", "powerful belting vocals", "soft breathy vocals", "raspy vocals", "smooth crooning vocals", "vocal harmonies and backing vocals", "spoken word", "a children's choir", "operatic vocals"]
PRODUCTION = ["lo-fi", "polished studio production", "live concert recording", "acoustic and unplugged", "orchestral", "electronic", "vintage 60s", "70s", "80s retro", "90s", "2000s", "modern trap production", "reverb-heavy and atmospheric", "minimal and sparse", "wall of sound", "distorted and noisy", "clean and bright", "warm and analog"]

CATEGORIES = {
    "genres": (GENRES, "This is {} music."),
    "moods": (MOODS, "The mood of this music is {}."),
    "instruments": (INSTRUMENTS, "This music features {}."),
    "vocals": (VOCALS, "This song has {}."),
    "production": (PRODUCTION, "This recording sounds {}."),
}

Progress = Callable[[str], None]


def _noop(_: str) -> None:
    pass


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def youtube_id(url: str) -> Optional[str]:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- download

def download_youtube(url: str, work: Path) -> tuple[Path, dict]:
    """Best audio track of the video as `work/src.<ext>` plus the metadata the prompt writer can use."""
    from yt_dlp import YoutubeDL

    opts = {"format": "bestaudio/best", "outtmpl": str(work / "src.%(ext)s"), "noplaylist": True, "quiet": True, "noprogress": True, "no_warnings": True, "retries": 3}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get("_type") == "playlist":
            entries = info.get("entries") or []
            if not entries:
                raise ValueError("La URL es una lista sin videos")
            info = entries[0]
        duration = float(info.get("duration") or 0)
        if duration > MAX_SECONDS:
            raise ValueError(f"El video dura {int(duration // 60)} min; el análisis acepta hasta {MAX_SECONDS // 60} min (una canción, no un mix)")
        ydl.download([info.get("webpage_url") or url])
    src = next((p for p in work.glob("src.*") if p.suffix not in {".part", ".json"}), None)
    if src is None:
        raise RuntimeError("yt-dlp no dejó ningún archivo de audio")
    meta = {
        "id": info.get("id"),
        "url": info.get("webpage_url") or url,
        "title": info.get("title"),
        "channel": info.get("channel") or info.get("uploader"),
        "duration": duration or None,
        "upload_date": info.get("upload_date"),
        "view_count": info.get("view_count"),
        "tags": (info.get("tags") or [])[:20],
        "categories": info.get("categories") or [],
        "description": (info.get("description") or "")[:800],
        "artist": info.get("artist") or info.get("creator"),
        "track": info.get("track"),
        "album": info.get("album"),
    }
    return src, meta


# --------------------------------------------------------------------------- signal features

def detect_key(chroma: np.ndarray) -> tuple[str, float]:
    """Krumhansl-Schmuckler: correlate the mean chroma with the 24 rotated key profiles."""
    profile = chroma.mean(axis=1)
    if profile.sum() <= 0:
        return "unknown", 0.0
    scores = []
    for i in range(12):
        for name, prof in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            scores.append((float(np.corrcoef(profile, np.roll(prof, i))[0, 1]), f"{NOTE_NAMES[i]} {name}"))
    scores.sort(reverse=True)
    best, second = scores[0][0], scores[1][0]
    return scores[0][1], float(max(0.0, min(1.0, (best - second) * 4 + 0.2)))


def detect_tempo(y: np.ndarray, sr: int) -> tuple[int, float, list[int]]:
    """Global tempo with a pulse-clarity score and the half/double-time alternatives."""
    import librosa

    oenv = librosa.onset.onset_strength(y=y, sr=sr, aggregate=np.median)
    tempo_fn = librosa.feature.tempo if hasattr(librosa.feature, "tempo") else librosa.beat.tempo
    # Per-frame estimates: the median survives intros/outros better than one global aggregate.
    dyn = np.asarray(tempo_fn(onset_envelope=oenv, sr=sr, aggregate=None)).ravel()
    tempo = float(np.median(dyn)) if dyn.size else float(np.atleast_1d(tempo_fn(onset_envelope=oenv, sr=sr))[0])
    agreement = float(np.mean(np.abs(dyn - tempo) < 3)) if dyn.size else 0.5
    bpm = int(round(tempo))
    alts = sorted({int(round(tempo / 2)), int(round(tempo * 2))} - {bpm})
    return bpm, round(agreement, 2), [a for a in alts if 40 <= a <= 240]


def energy_curve(y: np.ndarray, sr: int, step_s: float = 2.0) -> np.ndarray:
    hop = int(sr * step_s)
    n = max(1, len(y) // hop)
    rms = np.array([np.sqrt(np.mean(y[i * hop : (i + 1) * hop] ** 2)) for i in range(n)]) + 1e-9
    db = 20 * np.log10(rms)
    top = np.percentile(db, 95)
    return np.clip((db - (top - 30)) / 30, 0, 1)


def sections(y: np.ndarray, sr: int, duration: float) -> list[dict]:
    """Coarse section map: agglomerative clustering of beat-synchronous chroma+MFCC+RMS, then each
    segment labelled by its loudness relative to the song (intro/outro by position)."""
    import librosa

    hop = 512
    k = int(max(4, min(10, round(duration / 28))))
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
    rms = librosa.feature.rms(y=y, hop_length=hop)
    feats = np.vstack([chroma, mfcc / (np.abs(mfcc).max() + 1e-9), rms / (rms.max() + 1e-9)])
    _, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    if len(beats) < k * 4:
        beats = np.arange(0, feats.shape[1], max(1, feats.shape[1] // (k * 8)))
    sync = librosa.util.sync(feats, beats, aggregate=np.mean)
    if sync.shape[1] <= k:
        return []
    bounds = librosa.segment.agglomerative(sync, k)
    beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=hop)
    # The first beat can land well into a sparse intro: the first section always starts at 0.
    starts = [0.0] + [float(beat_times[min(b, len(beat_times) - 1)]) for b in bounds[1:]]
    # Merge sections shorter than 4 s into the previous one so the map stays contiguous.
    merged: list[float] = []
    for s in starts:
        if merged and s - merged[-1] < 4:
            continue
        merged.append(s)
    if duration - merged[-1] < 4 and len(merged) > 1:
        merged.pop()
    starts = merged
    ends = starts[1:] + [duration]
    frame_db = 20 * np.log10(rms[0] + 1e-9)
    times = librosa.frames_to_time(np.arange(rms.shape[1]), sr=sr, hop_length=hop)
    levels = []
    for s, e in zip(starts, ends):
        m = (times >= s) & (times < e)
        levels.append(float(np.median(frame_db[m])) if m.any() else -60.0)
    lv = np.array(levels)
    hi, lo = np.percentile(lv, 75), np.percentile(lv, 25)
    out = []
    for i, (s, e, db) in enumerate(zip(starts, ends, levels)):
        energy = "high" if db >= hi else "low" if db <= lo else "mid"
        role = "intro" if i == 0 and energy != "high" else "outro" if i == len(starts) - 1 and energy != "high" else "peak" if energy == "high" else "section"
        out.append({"start": round(s, 1), "end": round(e, 1), "energy": energy, "role": role, "level_db": round(db, 1)})
    return out


def signal_features(wav: Path, progress: Progress) -> dict:
    import librosa

    progress("Midiendo tempo, tonalidad y energía")
    y, sr = librosa.load(str(wav), sr=ANALYSIS_SR, mono=True)
    duration = len(y) / sr
    bpm, pulse, alts = detect_tempo(y, sr)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key, key_conf = detect_key(chroma)
    frame_rms = librosa.feature.rms(y=y)[0] + 1e-9
    frame_db = 20 * np.log10(frame_rms)
    loud = frame_db[frame_db > np.percentile(frame_db, 5)]
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85)))
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    S = np.abs(librosa.stft(y, n_fft=2048)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    band = lambda lo, hi: float(S[(freqs >= lo) & (freqs < hi)].sum() + 1e-12)  # noqa: E731
    total = band(20, sr / 2)
    curve = energy_curve(y, sr)
    return {
        "duration": round(duration, 1),
        "bpm": bpm,
        "bpm_alternatives": alts,
        "pulse_clarity": pulse,
        "key": key,
        "key_confidence": round(key_conf, 2),
        "loudness_dbfs": round(float(np.mean(loud)), 1),
        "dynamic_range_db": round(float(np.percentile(loud, 95) - np.percentile(loud, 10)), 1),
        "brightness_hz": int(centroid),
        "rolloff_hz": int(rolloff),
        "onsets_per_sec": round(len(onsets) / max(duration, 1), 2),
        "spectrum": {"sub_bass": round(band(20, 80) / total, 3), "bass": round(band(80, 250) / total, 3), "mids": round(band(250, 2000) / total, 3), "highs": round(band(2000, 8000) / total, 3), "air": round(band(8000, sr / 2) / total, 3)},
        "energy_curve": [round(float(v), 2) for v in curve],
        "energy_step_s": 2.0,
        "structure": sections(y, sr, duration),
    }


# --------------------------------------------------------------------------- stems + vocals

def separate_stems(separator, song_wav: Path, out_dir: Path) -> dict[str, Path]:
    """All four htdemucs stems as WAV files (stereo, 44.1 kHz)."""
    from demucs.api import save_audio

    try:
        _, stems = separator.separate_audio_file(song_wav)
    except Exception as exc:  # noqa: BLE001
        if separator.device == "cpu":
            raise
        print(f"[reference] Demucs failed on {separator.device} ({exc}); retrying on cpu", flush=True)
        separator.update_parameter(device="cpu")
        _, stems = separator.separate_audio_file(song_wav)
    paths = {}
    for name, tensor in stems.items():
        p = out_dir / f"{name}.wav"
        save_audio(tensor, p, samplerate=separator.samplerate)
        paths[name] = p
    inst = sum(v for k, v in stems.items() if k != "vocals")
    paths["instrumental"] = out_dir / "instrumental.wav"
    save_audio(inst, paths["instrumental"], samplerate=separator.samplerate)
    return paths


def _mono(path: Path) -> tuple[np.ndarray, int]:
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    return y.mean(axis=1), sr


def vocal_windows(vocals: np.ndarray, sr: int, seconds: float = 30.0) -> tuple[int, int, float, float]:
    """(start, end) samples of the most sung `seconds` plus the fraction of the song with vocals."""
    frame = int(sr * 0.05)
    n = max(1, len(vocals) // frame)
    env = np.sqrt(np.mean(vocals[: n * frame].reshape(n, frame) ** 2, axis=1)) + 1e-9
    db = 20 * np.log10(env)
    thr = max(np.percentile(db, 90) - 25, -50)
    active = (db > thr).astype(np.float32)
    activity = float(active.mean())
    win = int(seconds / 0.05)
    if n <= win:
        return 0, len(vocals), activity, activity
    hop = 10
    scores = np.array([active[i : i + win].mean() for i in range(0, n - win, hop)])
    best = int(np.argmax(scores)) * hop
    return best * frame, (best + win) * frame, activity, float(scores.max())


def vocal_profile(vocals_wav: Path, progress: Progress) -> dict:
    """Presence, activity and sung pitch profile of the vocal stem."""
    import librosa

    v, sr = _mono(vocals_wav)
    peak_db = 20 * np.log10(np.percentile(np.abs(v), 99.5) + 1e-9)
    start, end, activity, density = vocal_windows(v, sr)
    present = peak_db > -30 and activity > 0.08
    out = {"present": bool(present), "activity": round(activity, 2), "peak_dbfs": round(float(peak_db), 1), "best_window": [round(start / sr, 1), round(end / sr, 1)], "best_window_density": round(density, 2)}
    if not present:
        return out
    progress("Midiendo el registro de la voz")
    # Pitch on the most sung 60 s (two windows) at 16 kHz.
    y16 = librosa.resample(v[start:end], orig_sr=sr, target_sr=16000)
    f0, voiced, prob = librosa.pyin(y16, fmin=65, fmax=1100, sr=16000, frame_length=1024, hop_length=256)
    voiced = voiced & np.isfinite(f0) & (prob > 0.5) & (f0 > 60)
    if voiced.sum() >= 50:
        med = float(np.median(f0[voiced]))
        voiced &= (f0 > med / 2) & (f0 < med * 2)
    hz = f0[voiced]
    if len(hz) < 50:
        out["pitch"] = None
        return out
    p10, p50, p90 = (float(x) for x in np.percentile(hz, [10, 50, 90]))
    register = next(name for limit, name in SINGING_REGISTERS if p50 < limit)
    gender = "male" if p50 < 175 else "female" if p50 > 230 else "ambiguous"
    out["pitch"] = {"median_hz": round(p50, 1), "p10_hz": round(p10, 1), "p90_hz": round(p90, 1), "median_note": hz_to_note(p50), "low_note": hz_to_note(p10), "high_note": hz_to_note(p90), "register": register, "gender_guess": gender}
    return out


def hz_to_note(hz: float) -> str:
    midi = int(round(69 + 12 * np.log2(hz / 440)))
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def stem_balance(stems: dict[str, Path]) -> dict:
    rms = {}
    for name in ("drums", "bass", "other", "vocals"):
        y, _ = _mono(stems[name])
        rms[name] = float(np.sqrt(np.mean(y**2))) + 1e-9
    total = sum(rms.values())
    return {k: round(v / total, 3) for k, v in rms.items()}


# --------------------------------------------------------------------------- CLAP zero-shot

_clap = None
_clap_device = "cpu"


def load_clap(device: str):
    global _clap, _clap_device
    if _clap is None:
        import torch
        from transformers import ClapModel, ClapProcessor

        print(f"[reference] loading CLAP {CLAP_MODEL}...", flush=True)
        model = ClapModel.from_pretrained(CLAP_MODEL).eval()
        processor = ClapProcessor.from_pretrained(CLAP_MODEL)
        try:
            model = model.to(device)
            with torch.no_grad():
                model.get_audio_features(**processor(audios=[np.zeros(CLAP_SR, dtype=np.float32)], sampling_rate=CLAP_SR, return_tensors="pt").to(device))
            _clap_device = device
        except Exception as exc:  # noqa: BLE001
            print(f"[reference] CLAP on {device} failed ({exc}); using cpu", flush=True)
            model = model.to("cpu")
            _clap_device = "cpu"
        _clap = (model, processor)
        print(f"[reference] CLAP ready on {_clap_device}", flush=True)
    return _clap


def _windows(y: np.ndarray, sr: int, n: int = CLAP_WINDOWS, seconds: float = CLAP_WINDOW_S) -> list[np.ndarray]:
    win = int(seconds * sr)
    if len(y) <= win:
        return [y]
    # Skip the first/last 8 %: intros and fades say little about the song.
    lo, hi = int(0.08 * len(y)), int(0.92 * len(y)) - win
    if hi <= lo:
        lo, hi = 0, len(y) - win
    starts = np.linspace(lo, hi, n).astype(int)
    return [y[s : s + win] for s in starts]


def clap_scores(model, processor, windows: list[np.ndarray], labels: list[str], template: str, top: int) -> list[dict]:
    """Mean softmax over the windows for one category → top labels with scores in [0, 1]."""
    import torch

    texts = [template.format(label) for label in labels]
    with torch.no_grad():
        t = processor(text=texts, return_tensors="pt", padding=True).to(_clap_device)
        text_emb = model.get_text_features(**t)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        a = processor(audios=windows, sampling_rate=CLAP_SR, return_tensors="pt").to(_clap_device)
        audio_emb = model.get_audio_features(**a)
        audio_emb = audio_emb / audio_emb.norm(dim=-1, keepdim=True)
        logits = model.logit_scale_a.exp() * audio_emb @ text_emb.T
        per_window = logits.softmax(dim=-1).cpu().numpy()  # (windows, labels)
    probs = per_window.mean(axis=0)
    # A label that wins a few windows (a piano in the verses, a solo) still matters even when the
    # mean is small; `hits` = fraction of windows where it ranked in the top 3.
    ranks = np.argsort(-per_window, axis=1)[:, :3]
    hits = np.array([np.mean([i in r for r in ranks]) for i in range(len(labels))])
    combined = 0.5 * probs / (probs.max() + 1e-9) + 0.5 * hits
    order = np.argsort(-combined)[:top]
    return [{"label": labels[i], "score": round(float(probs[i]), 3), "hits": round(float(hits[i]), 2)} for i in order]


def clap_tags(stems: dict[str, Path], song_wav: Path, has_vocals: bool, device: str, progress: Progress) -> dict:
    import librosa

    progress("Etiquetando género, mood e instrumentos (CLAP)")
    model, processor = load_clap(device)

    def windows_of(path: Path) -> list[np.ndarray]:
        y, _ = librosa.load(str(path), sr=CLAP_SR, mono=True)
        return _windows(y, CLAP_SR)

    mix_w = windows_of(song_wav)
    score = lambda w, labels, template, top: clap_scores(model, processor, w, labels, template, top)  # noqa: E731
    instruments = [
        *[{**x, "group": "melodic"} for x in score(windows_of(stems["other"]), MELODIC, "This music features {}.", 5)],
        *[{**x, "group": "percussion"} for x in score(windows_of(stems["drums"]), PERCUSSION, "The drums in this music are {}.", 3)],
        *[{**x, "group": "bass"} for x in score(windows_of(stems["bass"]), BASS, "The bass in this music is {}.", 2)],
    ]
    out = {
        "genres": score(mix_w, GENRES, CATEGORIES["genres"][1], 8),
        "moods": score(mix_w, MOODS, CATEGORIES["moods"][1], 6),
        "instruments": instruments,
        "production": score(mix_w, PRODUCTION, CATEGORIES["production"][1], 5),
        "vocals": [],
        "vocal_gender": None,
    }
    if has_vocals:
        voc_w = windows_of(stems["vocals"])
        out["vocals"] = score(voc_w, VOCALS, CATEGORIES["vocals"][1], 6)
        # The pitch alone misreads high male pop voices (a tenor living at E4 looks "female"); the
        # timbre contrast man/woman on the isolated vocal stem was right on every song tried.
        pair = score(voc_w, ["a man singing", "a woman singing"], "This song has {}.", 2)
        out["vocal_gender"] = {("male" if x["label"].startswith("a man") else "female"): x["score"] for x in pair}
    return out


def finalize_vocals(vocals: dict, gender_scores: Optional[dict]) -> dict:
    """Combines the pitch profile with CLAP's man/woman contrast: CLAP decides when it is confident,
    the pitch breaks ties; the register is then read on the right gender's scale."""
    pitch = vocals.get("pitch")
    if not vocals.get("present"):
        return vocals
    male = (gender_scores or {}).get("male")
    if male is not None and abs(male - 0.5) >= 0.15:
        gender, conf = ("male" if male > 0.5 else "female"), round(abs(male - 0.5) * 2, 2)
    elif pitch:
        gender, conf = pitch["gender_guess"], 0.3
    else:
        gender, conf = "ambiguous", 0.0
    vocals["gender"] = gender
    vocals["gender_confidence"] = conf
    if pitch:
        p50 = pitch["median_hz"]
        if gender == "male":
            pitch["register"] = "bass" if p50 < 150 else "baritone" if p50 < 200 else "tenor"
        elif gender == "female":
            pitch["register"] = "alto" if p50 < 330 else "mezzo-soprano" if p50 < 400 else "soprano"
        pitch["gender_guess"] = gender
    return vocals


# --------------------------------------------------------------------------- language

_whisper = None


def detect_language(vocals_wav: Path, window: tuple[float, float], work: Path, progress: Progress) -> dict:
    """Language + a transcript snippet of the most sung 30 s (faster-whisper small on CPU)."""
    global _whisper
    progress("Detectando idioma de la letra")
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel("small", device="cpu", compute_type="int8")
    clip = work / "lang.wav"
    ffmpeg("-ss", str(window[0]), "-t", str(max(5.0, window[1] - window[0])), "-i", str(vocals_wav), "-ac", "1", "-ar", "16000", str(clip))
    segments, info = _whisper.transcribe(str(clip), beam_size=1, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments)[:400]
    return {"language": info.language, "language_probability": round(float(info.language_probability), 2), "transcript_snippet": text}


# --------------------------------------------------------------------------- orchestration

def analyze_reference_source(source: str, work: Path, separator, device: str = "cpu", progress: Progress = _noop) -> dict:
    """Full analysis of a YouTube URL or a local audio file. `separator` is a loaded demucs Separator."""
    t0 = time.time()
    timings: dict[str, float] = {}
    work.mkdir(parents=True, exist_ok=True)
    if re.match(r"^https?://", source):
        progress("Descargando el audio de YouTube")
        src, meta = download_youtube(source, work)
        timings["download"] = round(time.time() - t0, 1)
    else:
        src, meta = Path(source), {"title": Path(source).stem, "url": None, "id": None}
    song = work / "song44.wav"
    ffmpeg("-i", str(src), "-vn", "-ac", "2", "-ar", str(SR), str(song))
    if meta.get("duration") is None:
        meta["duration"] = round(sf.info(song).duration, 1)
    if meta["duration"] > MAX_SECONDS:
        raise ValueError(f"El audio dura más de {MAX_SECONDS // 60} min")

    t = time.time()
    features = signal_features(song, progress)
    timings["features"] = round(time.time() - t, 1)

    t = time.time()
    progress("Separando voz, batería, bajo y resto (Demucs)")
    stems = separate_stems(separator, song, work)
    balance = stem_balance(stems)
    vocals = vocal_profile(stems["vocals"], progress)
    timings["stems"] = round(time.time() - t, 1)

    t = time.time()
    tags = clap_tags(stems, song, vocals["present"], device, progress)
    vocals = finalize_vocals(vocals, tags.pop("vocal_gender", None))
    timings["clap"] = round(time.time() - t, 1)

    lang = None
    if vocals["present"]:
        t = time.time()
        try:
            lang = detect_language(stems["vocals"], tuple(vocals["best_window"]), work, progress)
        except Exception as exc:  # noqa: BLE001
            print(f"[reference] language detection failed: {exc}", flush=True)
        timings["language"] = round(time.time() - t, 1)
    timings["total"] = round(time.time() - t0, 1)
    return {"source": meta, **features, "stems": balance, "vocals": {**vocals, **(lang or {})}, "tags": tags, "timings": timings}


def _standalone_separator(device: str):
    from demucs.api import Separator

    try:
        return Separator(model="htdemucs", device=device, segment=7.8, progress=False)
    except Exception:  # noqa: BLE001
        return Separator(model="htdemucs", device="cpu", segment=7.8, progress=False)


if __name__ == "__main__":
    import os
    import tempfile

    if len(sys.argv) < 2:
        print("usage: reference.py <youtube-url-or-audio-file>")
        sys.exit(1)
    dev = os.environ.get("VOICE_DEVICE", "cpu")
    tmp = Path(tempfile.mkdtemp(prefix="reference-"))
    try:
        result = analyze_reference_source(sys.argv[1], tmp, _standalone_separator(dev), dev, progress=lambda s: print(f"[reference] {s}", flush=True))
        print(json.dumps(result, ensure_ascii=False, indent=1))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
