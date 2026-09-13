"""Vocal-stem metrics for A/B of conversions. CPU only (never touches the service's GPU).
usage: measure.py <label> <audio> [--ref <label_of_reference_stem>] [--no-sep]
Separates with Demucs htdemucs on CPU into stems/<label>/vocals.wav (cached), then prints:
hi_mid_db, flatness, hnr_db (HPSS harmonic/percussive), hf8k_db (8-16k vs 0.3-3k), centroid,
and, with --ref, correlation of F0 (pyin) and RMS envelope against the reference label's stem."""
import sys, json, argparse
from pathlib import Path
import numpy as np, soundfile as sf, librosa
SR = 44100
HERE = Path(__file__).resolve().parent
STEMS = HERE / "stems"

def separate(audio: Path, out_dir: Path) -> Path:
    voc = out_dir / "vocals.wav"
    if voc.exists():
        return voc
    import subprocess, tempfile
    out_dir.mkdir(parents=True, exist_ok=True)
    wav = out_dir / "song.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(audio), "-ac", "2", "-ar", str(SR), str(wav)], check=True)
    from demucs.api import Separator, save_audio
    sep = Separator(model="htdemucs", device="cpu", segment=7.8, progress=False)
    _, stems = sep.separate_audio_file(wav)
    save_audio(stems["vocals"], voc, samplerate=sep.samplerate)
    save_audio(sum(v for k, v in stems.items() if k != "vocals"), out_dir / "instrumental.wav", samplerate=sep.samplerate)
    wav.unlink()
    return voc

def load_mono(p: Path):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    assert sr == SR, sr
    return y.mean(1)

def metrics(y: np.ndarray) -> dict:
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512)) ** 2
    f = librosa.fft_frequencies(sr=SR, n_fft=2048)
    level = 10 * np.log10(S.sum(0) + 1e-12)
    loud = level > np.percentile(level, 60)
    band = lambda lo, hi: S[(f >= lo) & (f < hi)][:, loud].sum()
    mid = band(300, 3000)
    hi_mid = 10 * np.log10((band(3000, 7000) + 1e-12) / (mid + 1e-12))
    hf8k = 10 * np.log10((band(8000, 16000) + 1e-12) / (mid + 1e-12))
    flat = librosa.feature.spectral_flatness(S=np.sqrt(S))[0]
    cent = librosa.feature.spectral_centroid(S=np.sqrt(S), sr=SR)[0]
    # HNR via HPSS on the loud frames (harmonic vs residual energy)
    H, P = librosa.decompose.hpss(librosa.stft(y, n_fft=2048, hop_length=512), margin=2.0)
    eh, ep = (np.abs(H) ** 2)[:, loud].sum(), (np.abs(P) ** 2)[:, loud].sum()
    # noise-likeness of the 3-7k band: flatness restricted to that band
    sub = S[(f >= 3000) & (f < 7000)][:, loud]
    gm = np.exp(np.mean(np.log(sub + 1e-12), axis=0)); am = np.mean(sub, axis=0) + 1e-12
    return {
        "hi_mid_db": round(float(hi_mid), 2),
        "hf8k_db": round(float(hf8k), 2),
        "flatness": round(float(np.mean(flat[loud])), 4),
        "flat_3_7k": round(float(np.mean(gm / am)), 4),
        "centroid_hz": round(float(np.mean(cent[loud])), 0),
        "hnr_db": round(float(10 * np.log10((eh + 1e-12) / (ep + 1e-12))), 2),
        "rms_dbfs": round(float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-9)), 1),
    }

def f0_curve(y):
    y16 = librosa.resample(y, orig_sr=SR, target_sr=16000)
    f0, v, p = librosa.pyin(y16, fmin=60, fmax=1000, sr=16000, frame_length=1024, hop_length=160)
    f0 = np.where(v & np.isfinite(f0) & (p > 0.5), f0, 0.0)
    return f0

def env(y):
    from scipy.ndimage import uniform_filter1d
    return np.sqrt(uniform_filter1d(y.astype(np.float64) ** 2, size=5292))[::2205]

def cpp(y: np.ndarray, sr: int = SR, n_fft: int = 2048, hop: int = 512, fmin: float = 60.0, fmax: float = 600.0):
    """Cepstral peak prominence per frame (dB): peak of the cepstrum in the F0 quefrency range above a
    linear fit of the cepstrum. Higher = clearer harmonic structure; lower = breathy/rough/noisy voice."""
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop)) + 1e-9
    logS = 20 * np.log10(S)
    cep = np.abs(np.fft.irfft(logS, axis=0))
    q = np.arange(cep.shape[0]) / sr
    qmin, qmax = 1 / fmax, 1 / fmin
    sel = (q >= qmin) & (q <= qmax)
    x = q[sel]
    out = []
    for i in range(cep.shape[1]):
        c = cep[sel, i]
        c_db = 20 * np.log10(c + 1e-12)
        a, b = np.polyfit(x, c_db, 1)
        k = int(np.argmax(c_db))
        out.append(c_db[k] - (a * x[k] + b))
    return np.array(out)

def fine_structure(conv: np.ndarray, orig: np.ndarray) -> dict:
    """Frame-aligned comparison (same performance, so frames line up): log-spectral distance per band on
    loud frames, and CPP on both (voice-quality: harmonics vs noise)."""
    n_fft, hop = 2048, 512
    Sc = np.abs(librosa.stft(conv, n_fft=n_fft, hop_length=hop)) + 1e-9
    So = np.abs(librosa.stft(orig, n_fft=n_fft, hop_length=hop)) + 1e-9
    n = min(Sc.shape[1], So.shape[1]); Sc, So = Sc[:, :n], So[:, :n]
    f = librosa.fft_frequencies(sr=SR, n_fft=n_fft)
    lvl = 10 * np.log10((So ** 2).sum(0)); loud = lvl > np.percentile(lvl, 60)
    Lc, Lo = 20 * np.log10(Sc[:, loud]), 20 * np.log10(So[:, loud])
    # remove per-frame overall gain difference so LSD measures shape, not level
    Lc = Lc - (Lc.mean(0) - Lo.mean(0))[None, :]
    res = {}
    for name, lo, hi in (("lsd_0_2k", 80, 2000), ("lsd_2_5k", 2000, 5000), ("lsd_5_10k", 5000, 10000)):
        m = (f >= lo) & (f < hi)
        res[name] = round(float(np.sqrt(np.mean((Lc[m] - Lo[m]) ** 2))), 2)
    # envelope-level distance (80 log-mel bands): robust to sub-frame timing offsets, unlike the bin-level LSD
    Mc = librosa.feature.melspectrogram(S=Sc ** 2, sr=SR, n_mels=80, fmax=12000)
    Mo = librosa.feature.melspectrogram(S=So ** 2, sr=SR, n_mels=80, fmax=12000)
    Lmc, Lmo = 10 * np.log10(Mc[:, loud] + 1e-12), 10 * np.log10(Mo[:, loud] + 1e-12)
    Lmc = Lmc - (Lmc.mean(0) - Lmo.mean(0))[None, :]
    res["mel_lsd"] = round(float(np.sqrt(np.mean((Lmc - Lmo) ** 2))), 2)
    cc, co = cpp(conv), cpp(orig)
    m = min(len(cc), len(co), n)
    res["cpp_conv_db"] = round(float(np.mean(cc[:m][loud[:m]])), 2)
    res["cpp_orig_db"] = round(float(np.mean(co[:m][loud[:m]])), 2)
    return res

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("label"); ap.add_argument("audio"); ap.add_argument("--ref"); ap.add_argument("--no-sep", action="store_true")
    a = ap.parse_args()
    src = Path(a.audio).resolve()
    voc = src if a.no_sep else separate(src, STEMS / a.label)
    y = load_mono(voc)
    out = {"label": a.label, "seconds": round(len(y) / SR, 1), **metrics(y)}
    if a.ref:
        r = load_mono(STEMS / a.ref / "vocals.wav")
        n = min(len(y), len(r)); y2, r2 = y[:n], r[:n]
        out["env_corr"] = round(float(np.corrcoef(env(y2), env(r2))[0, 1]), 4)
        fa, fb = f0_curve(y2), f0_curve(r2)
        m = min(len(fa), len(fb)); fa, fb = fa[:m], fb[:m]
        both = (fa > 0) & (fb > 0)
        out["f0_voiced_both"] = round(float(both.mean()), 3)
        out["f0_corr_st"] = round(float(np.corrcoef(12 * np.log2(fa[both]), 12 * np.log2(fb[both]))[0, 1]), 4)
        d = np.abs(12 * np.log2(fa[both] / fb[both]))
        out["f0_med_abs_dev_st"] = round(float(np.median(d)), 3)
        out["f0_frames_gt1st"] = round(float((d > 1).mean()), 3)
        out.update(fine_structure(y2, r2))
    print(json.dumps(out))
    with (HERE / "metrics.jsonl").open("a") as fh:
        fh.write(json.dumps(out) + "\n")

if __name__ == "__main__":
    main()
