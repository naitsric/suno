#!/usr/bin/env bash
# One-time setup of the render node (run ON the instance). Idempotent.
set -euo pipefail
cd ~
if ! command -v uv >/dev/null; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
export PATH="$HOME/.local/bin:$PATH"
mkdir -p ~/suno-video && cd ~/suno-video
[ -d .venv ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cu128 torch torchvision
uv pip install --python .venv/bin/python "diffusers>=0.35" transformers accelerate ftfy imageio imageio-ffmpeg librosa opencv-python-headless pillow numpy huggingface_hub sentencepiece protobuf
sudo apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1; which ffmpeg
# weights on the persistent root volume
uvx --from huggingface_hub hf download Wan-AI/Wan2.1-VACE-1.3B-diffusers >/dev/null
echo "setup done: $(du -sh ~/.cache/huggingface/hub | cut -f1) of weights, torch $(.venv/bin/python -c 'import torch;print(torch.__version__, torch.cuda.is_available())')"
