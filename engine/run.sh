#!/usr/bin/env bash
# Launches the ACE-Step 1.5 REST API (port 8001) using the config in engine/.env
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d "$DIR/ACE-Step-1.5" ]] || { echo "Engine not installed. Run: make setup-engine"; exit 1; }
set -a; source "$DIR/.env"; set +a
cp -f "$DIR/.env" "$DIR/ACE-Step-1.5/.env"
cd "$DIR/ACE-Step-1.5"
exec uv run --no-sync acestep-api --host "${ACESTEP_API_HOST:-127.0.0.1}" --port "${ACESTEP_API_PORT:-8001}" --lm-model-path "${ACESTEP_LM_MODEL_PATH:-acestep-5Hz-lm-0.6B}"
