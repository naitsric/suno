#!/usr/bin/env bash
# Local: poll the node until the Wan2.2 tests finish, pull their outputs, stop the node.
cd "$(dirname "$0")/.."
KEY=~/.ssh/suno-video-render.pem
mkdir -p poc/out/tests
while true; do
  IP=$(python3 cloud/remote.py status | awk '{print $2}')
  ST=$(python3 cloud/remote.py status | awk '{print $1}')
  if [ "$ST" != "running" ]; then echo "[$(date +%H:%M:%S)] node is $ST (watchdog?) - starting it to pull results"; IP=$(python3 cloud/remote.py start | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | tail -1); fi
  LINE=$(ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=10 ubuntu@$IP 'tail -1 ~/suno-video/tests/driver.log 2>/dev/null' 2>/dev/null)
  echo "[$(date +%H:%M:%S)] $LINE"
  if echo "$LINE" | grep -q TESTS-DONE || [ "$ST" != "running" ]; then
    scp -q -i $KEY ubuntu@$IP:'suno-video/tests/*.log' poc/out/tests/ 2>/dev/null
    scp -q -i $KEY ubuntu@$IP:'suno-video/tests/*.mp4' poc/out/tests/ 2>/dev/null
    scp -q -i $KEY ubuntu@$IP:suno-video/poc/out/clip_vace14b.mp4 poc/out/tests/ 2>/dev/null
    scp -q -i $KEY ubuntu@$IP:suno-video/poc/out/clip_vace14b.json poc/out/tests/ 2>/dev/null
    ls -la poc/out/tests/
    python3 cloud/remote.py stop
    echo "[$(date +%H:%M:%S)] PULLED-AND-STOPPED"
    break
  fi
  sleep 300
done
