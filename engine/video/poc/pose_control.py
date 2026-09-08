"""Procedural OpenPose control video: a singer swaying and bobbing on the beats of a song segment."""
import argparse, json, math
import cv2, librosa, numpy as np
from PIL import Image
from common import OUT, log

COLORS = [[255,0,0],[255,85,0],[255,170,0],[255,255,0],[170,255,0],[85,255,0],[0,255,0],[0,255,85],[0,255,170],
          [0,255,255],[0,170,255],[0,85,255],[0,0,255],[85,0,255],[170,0,255],[255,0,255],[255,0,170],[255,0,85]]
LIMBS = [[2,3],[2,6],[3,4],[4,5],[6,7],[7,8],[2,9],[9,10],[10,11],[2,12],[12,13],[13,14],[2,1],[1,15],[15,17],[1,16],[16,18],[3,17],[6,18]]


def draw(canvas, kps, stick=4):
    h, w = canvas.shape[:2]
    for i, (a, b) in enumerate(LIMBS[:17]):
        pa, pb = kps[a-1], kps[b-1]
        if pa is None or pb is None:
            continue
        mx, my = (pa[0]+pb[0])/2*w, (pa[1]+pb[1])/2*h
        length = math.hypot((pa[0]-pb[0])*w, (pa[1]-pb[1])*h)
        ang = math.degrees(math.atan2((pa[1]-pb[1])*h, (pa[0]-pb[0])*w))
        poly = cv2.ellipse2Poly((int(mx), int(my)), (int(length/2), stick), int(ang), 0, 360, 1)
        cv2.fillConvexPoly(canvas, poly, COLORS[i])
    for i, p in enumerate(kps):
        if p is not None:
            cv2.circle(canvas, (int(p[0]*w), int(p[1]*h)), stick, COLORS[i], -1)
    return canvas


def skeleton(t, beat_phase, bar_phase, energy):
    """Return 18 normalised keypoints (x,y) for a frontal singer at time t (seconds)."""
    bob = 0.018 * (1 - abs(2*beat_phase - 1)) * (0.6 + energy)      # down on the beat
    sway = 0.035 * math.sin(2*math.pi*bar_phase)                       # hips left/right per bar
    lean = 0.012 * math.sin(2*math.pi*bar_phase + 0.8)
    cx, top = 0.5 + sway*0.5, 0.12 + bob
    neck = (cx + lean, top + 0.10)
    nose = (neck[0] + 0.004*math.sin(7*t), neck[1] - 0.075 + 0.01*math.sin(2*math.pi*beat_phase))
    reye, leye = (nose[0]-0.016, nose[1]-0.014), (nose[0]+0.016, nose[1]-0.014)
    rear, lear = (nose[0]-0.036, nose[1]-0.006), (nose[0]+0.036, nose[1]-0.006)
    rsho, lsho = (neck[0]-0.095, neck[1]+0.015), (neck[0]+0.095, neck[1]+0.015)
    # right arm holds the mic close to the mouth
    relb = (rsho[0]-0.03, rsho[1]+0.14)
    rwri = (nose[0]-0.03, nose[1]+0.06)
    # left arm: raised fist on the strong half of the bar, relaxed otherwise
    raise_amt = max(0.0, math.sin(2*math.pi*bar_phase)) ** 2 * (0.5 + energy)
    lelb = (lsho[0]+0.06 - 0.02*raise_amt, lsho[1]+0.14 - 0.10*raise_amt)
    lwri = (lelb[0]+0.03 - 0.05*raise_amt, lelb[1]+0.13 - 0.36*raise_amt)
    hipy = neck[1] + 0.33
    rhip, lhip = (cx-0.065+sway, hipy), (cx+0.065+sway, hipy)
    rknee, lknee = (rhip[0]-0.01, hipy+0.22), (lhip[0]+0.02, hipy+0.22)
    rank, lank = (rknee[0]-0.01, hipy+0.44), (lknee[0]+0.02, hipy+0.44)
    return [nose, neck, rsho, relb, rwri, lsho, lelb, lwri, rhip, rknee, rank, lhip, lknee, lank, reye, leye, rear, lear]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--start", type=float, default=None, help="segment start (s); default = loudest window")
    ap.add_argument("--frames", type=int, default=81)
    ap.add_argument("--fps", type=int, default=16)
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--bpm", type=float, default=None)
    a = ap.parse_args()
    dur = a.frames / a.fps
    y, sr = librosa.load(a.audio, sr=22050, mono=True)
    if a.start is None:
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
        win = int(dur * sr / 512)
        sm = np.convolve(rms, np.ones(win)/win, mode="valid")
        a.start = float(np.argmax(sm) * 512 / sr)
    seg = y[int(a.start*sr): int((a.start+dur)*sr)]
    tempo, beats = librosa.beat.beat_track(y=seg, sr=sr, start_bpm=a.bpm or 120, units="time")
    tempo = float(np.atleast_1d(tempo)[0])
    beats = list(beats)
    if len(beats) < 2:
        period = 60 / (a.bpm or tempo or 120)
        beats = list(np.arange(0, dur + period, period))
    period = float(np.median(np.diff(beats)))
    rms = librosa.feature.rms(y=seg, hop_length=512)[0]
    rms = (rms - rms.min()) / (np.ptp(rms) + 1e-6)
    log(f"segment {a.start:.2f}s +{dur:.2f}s, tempo {tempo:.1f} bpm, {len(beats)} beats, period {period:.3f}s")
    frames = []
    for i in range(a.frames):
        t = i / a.fps
        prev = max([b for b in beats if b <= t], default=beats[0] - period)
        beat_phase = ((t - prev) / period) % 1.0
        nbeat = sum(1 for b in beats if b <= t)
        bar_phase = ((nbeat % 4) + beat_phase) / 4
        energy = float(rms[min(len(rms)-1, int(t*sr/512))])
        canvas = np.zeros((a.height, a.width, 3), np.uint8)
        frames.append(Image.fromarray(draw(canvas, skeleton(t, beat_phase, bar_phase, energy))))
    (OUT / "control").mkdir(exist_ok=True)
    for i, f in enumerate(frames):
        f.save(OUT / "control" / f"{i:03d}.png")
    import imageio
    imageio.mimwrite(OUT / "control.mp4", [np.array(f) for f in frames], fps=a.fps, codec="libx264", quality=8)
    json.dump({"audio": a.audio, "start": a.start, "duration": dur, "fps": a.fps, "frames": a.frames,
               "tempo": tempo, "width": a.width, "height": a.height}, open(OUT / "control.json", "w"), indent=2)
    log(f"wrote {len(frames)} control frames -> {OUT/'control.mp4'}")


if __name__ == "__main__":
    main()
