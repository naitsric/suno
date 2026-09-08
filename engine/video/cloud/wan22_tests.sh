#!/usr/bin/env bash
# Runs ON the node after the full video finishes: (1) same chorus clip with VACE 14B, (2) Wan2.2 S2V-14B with the vocal stem.
# Idempotent per test (skips if its output exists). Keeps the render lock so the idle watchdog does not power off mid-way.
set -uo pipefail
cd ~/suno-video
export PATH=$HOME/.local/bin:$PATH
touch /tmp/suno_render.lock
log(){ echo "[$(date +%H:%M:%S)] $*"; }

log "waiting for prep and for the full video to finish"
until grep -q PREP-DONE prep_wan22.log 2>/dev/null; do sleep 30; done
while pgrep -f full_video.py >/dev/null; do sleep 60; done
log "GPU is free"

# ---- test 1: VACE 14B (Wan 2.1), identical inputs to clip_l40s ----
if [ ! -f poc/out/clip_vace14b.mp4 ]; then
  log "test 1: VACE 14B"
  ( cd poc && WAN_MODEL_ID=Wan-AI/Wan2.1-VACE-14B-diffusers ../.venv/bin/python generate.py --ref out/ref.png --steps 30 --name clip_vace14b --fresh 2>&1 | tr '\r' '\n' | grep -E '^\[|Error|Traceback|out of memory' ) > tests/vace14b.log 2>&1
  log "test 1 done: $(tail -1 tests/vace14b.log | cut -c1-120)"
fi

# ---- test 2: Wan2.2 S2V-14B, reference portrait + chorus vocals (+ our pose video) ----
if [ ! -f tests/s2v_chorus.mp4 ]; then
  log "test 2: S2V-14B"
  PROMPT="Pixar style 3D animated music video, stylized CGI render of a young woman rock singer with big expressive eyes, tousled dark hair with red streaks, black leather jacket, singing passionately into a microphone on a concert stage, warm rim light and soft volumetric stage lights, Disney Pixar animation movie, high quality"
  for SIZE in "832*480" "1024*704"; do
    log "s2v size $SIZE"
    ( cd Wan2.2 && ../.venv-wan22/bin/python generate.py --task s2v-14B --size "$SIZE" --ckpt_dir ../Wan2.2-S2V-14B \
        --offload_model True --convert_model_dtype --t5_cpu --infer_frames 80 --num_clip 1 \
        --prompt "$PROMPT" --image ../tests/ref.png --audio ../tests/vocals.wav --pose_video ../poc/out/control.mp4 \
        --save_file ../tests/s2v_chorus_${SIZE/\*/x}.mp4 2>&1 | grep -vE "^\s*$" | tail -40 ) > "tests/s2v_${SIZE/\*/x}.log" 2>&1
    if ls tests/s2v_chorus_${SIZE/\*/x}.mp4 >/dev/null 2>&1; then cp tests/s2v_chorus_${SIZE/\*/x}.mp4 tests/s2v_chorus.mp4; log "s2v ok at $SIZE"; break; fi
    log "s2v failed at $SIZE: $(grep -iE 'error|memory' tests/s2v_${SIZE/\*/x}.log | tail -1 | cut -c1-140)"
  done
fi
rm -f /tmp/suno_render.lock
log "TESTS-DONE"
