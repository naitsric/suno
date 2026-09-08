#!/usr/bin/env bash
# Launches the stills video service (Wan VACE single frames + ffmpeg slideshow) on :8003
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -x "$DIR/../.venv/bin/python" ]] || { echo "Video env not installed (engine/video/.venv)"; exit 1; }
cd "$DIR"
exec "$DIR/../.venv/bin/python" "$DIR/server.py"
