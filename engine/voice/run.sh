#!/usr/bin/env bash
# Launches the voice conversion service (Demucs + Seed-VC) on :8002
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -x "$DIR/.venv/bin/python" ]] || { echo "Voice service not installed. Run: make setup-voice"; exit 1; }
exec "$DIR/.venv/bin/python" "$DIR/server.py"
