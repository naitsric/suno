#!/usr/bin/env bash
# Runs on the instance every minute (cron). Powers off after IDLE_MIN minutes without a render lock or GPU work.
IDLE_MIN=${IDLE_MIN:-15}
STAMP=/tmp/suno_last_busy
busy=0
[ -f /tmp/suno_render.lock ] && busy=1
util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1)
[ "${util:-0}" -gt 10 ] && busy=1
pgrep -f "generate.py|setup_remote.sh|uv pip|hf download" >/dev/null && busy=1
if [ "$busy" = 1 ]; then date +%s > $STAMP; exit 0; fi
[ -f $STAMP ] || date +%s > $STAMP
idle=$(( ($(date +%s) - $(cat $STAMP)) / 60 ))
if [ "$idle" -ge "$IDLE_MIN" ]; then logger "suno idle watchdog: idle ${idle} min, powering off"; sudo shutdown -h now; fi
