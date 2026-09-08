#!/usr/bin/env python3
"""Start the render node, push a job, run it, pull results, stop the node.

    remote.py start | stop | status | ssh
    remote.py setup                       # one-time: env + weights on the node
    remote.py render <audio.mp3> --bpm 128 [--name clip] [--steps 30] [--ref out/ref_1.png]
    remote.py run "<shell command on the node>"

The node is a stopped-not-terminated EC2 instance: its root EBS keeps the env and the weights.
Requires the AWS CLI default profile and ~/.ssh/suno-video-render.pem.
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIDEO = HERE.parent
REGION = "us-east-1"
PROFILE = os.environ.get("AWS_PROFILE", "default")
KEY = Path.home() / ".ssh" / "suno-video-render.pem"
INSTANCE = (VIDEO / ".instance_id").read_text().strip()
REMOTE_DIR = "~/suno-video"
SSH_OPTS = ["-i", str(KEY), "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=30"]


def aws(*args, query=None):
    cmd = ["aws", "--profile", PROFILE, "--region", REGION, *args, "--output", "text"]
    if query:
        cmd += ["--query", query]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


def state():
    return aws("ec2", "describe-instances", "--instance-ids", INSTANCE,
               query="Reservations[0].Instances[0].[State.Name,PublicIpAddress]").split()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def start():
    st = state()
    if st[0] != "running":
        log(f"instance is {st[0]}, starting")
        aws("ec2", "start-instances", "--instance-ids", INSTANCE)
        aws("ec2", "wait", "instance-running", "--instance-ids", INSTANCE)
    ip = state()[1]
    for _ in range(40):
        if subprocess.run(["ssh", *SSH_OPTS, "-o", "BatchMode=yes", f"ubuntu@{ip}", "true"], capture_output=True).returncode == 0:
            log(f"ssh ready at {ip}")
            return ip
        time.sleep(8)
    raise SystemExit("ssh never came up")


def stop():
    log("stopping instance")
    aws("ec2", "stop-instances", "--instance-ids", INSTANCE)


def ssh(ip, cmd, stream=True):
    full = ["ssh", *SSH_OPTS, f"ubuntu@{ip}", f"export PATH=$HOME/.local/bin:$PATH; cd {REMOTE_DIR} 2>/dev/null; {cmd}"]
    if stream:
        return subprocess.run(full).returncode
    return subprocess.run(full, capture_output=True, text=True).stdout


def rsync(src, dst, excludes=()):
    cmd = ["rsync", "-az", "-e", "ssh " + " ".join(SSH_OPTS)]
    for e in excludes:
        cmd += ["--exclude", e]
    subprocess.run(cmd + [src, dst], check=True)


def push_code(ip):
    rsync(str(VIDEO / "poc") + "/", f"ubuntu@{ip}:{REMOTE_DIR}/poc/", excludes=("out", "cache", "__pycache__", ".venv"))
    rsync(str(HERE) + "/", f"ubuntu@{ip}:{REMOTE_DIR}/cloud/")


def setup(ip):
    push_code(ip)
    ssh(ip, "bash cloud/setup_remote.sh")
    # idle watchdog: cron every minute, powers the node off after 15 idle minutes (shutdown behavior = stop)
    ssh(ip, "sudo cp cloud/idle_watchdog.sh /usr/local/bin/suno_idle_watchdog && sudo chmod +x /usr/local/bin/suno_idle_watchdog && "
            "(crontab -l 2>/dev/null | grep -v suno_idle_watchdog; echo '* * * * * /usr/local/bin/suno_idle_watchdog') | crontab - && echo watchdog installed")


def render(ip, audio, bpm, name, steps, ref, frames):
    push_code(ip)
    ssh(ip, f"mkdir -p poc/out && touch /tmp/suno_render.lock")
    rsync(audio, f"ubuntu@{ip}:{REMOTE_DIR}/poc/out/song.mp3")
    if ref:
        rsync(ref, f"ubuntu@{ip}:{REMOTE_DIR}/poc/out/ref.png")
    py = ".venv/bin/python"
    t0 = time.time()
    try:
        rc = ssh(ip, f"cd poc && ../{py} pose_control.py out/song.mp3 --bpm {bpm} --frames {frames} 2>&1 | grep -v Warn")
        if not ref:
            rc |= ssh(ip, f"cd poc && ../{py} ref_image.py --n 1 --steps {steps} 2>&1 | grep -E '^\\[|Error' ; cp out/ref_1.png out/ref.png")
        rc |= ssh(ip, f"cd poc && ../{py} generate.py --ref out/ref.png --steps {steps} --name {name} 2>&1 | grep -E '^\\[|Error|Traceback'")
    finally:
        ssh(ip, "rm -f /tmp/suno_render.lock", stream=False)
    log(f"remote render finished rc={rc} in {time.time()-t0:.0f}s")
    dst = VIDEO / "poc" / "out" / "remote"
    dst.mkdir(parents=True, exist_ok=True)
    for f in (f"{name}.mp4", f"{name}.json", "ref.png"):  # explicit names: openrsync on macOS does not expand remote globs
        subprocess.run(["scp", "-q", *SSH_OPTS, f"ubuntu@{ip}:{REMOTE_DIR.replace('~/', '')}/poc/out/{f}",
                        str(dst / (f"{name}_ref.png" if f == "ref.png" else f))], check=False)
    log(f"results in {dst}")
    return rc


def full(ip, audio, bpm, name, steps, ref, poll=60):
    """Run full_video.py DETACHED on the node (survives a dropped SSH), poll its log, pull final.mp4, stop the node."""
    push_code(ip)
    remote_out = f"{REMOTE_DIR}/poc/out/full/{name}"
    ssh(ip, f"mkdir -p poc/out {remote_out}", stream=False)
    rsync(audio, f"ubuntu@{ip}:{REMOTE_DIR}/poc/out/song_{name}.mp3")
    rsync(ref, f"ubuntu@{ip}:{REMOTE_DIR}/poc/out/ref_{name}.png")
    running = ssh(ip, "pgrep -f '[f]ull_video.py' >/dev/null && echo yes || echo no", stream=False).strip()  # [f] avoids matching this ssh command itself
    done = ssh(ip, f"test -f {remote_out}/final.mp4 && echo yes || echo no", stream=False).strip()
    if running == "no" and done == "no":
        log("launching full_video.py on the node")
        ssh(ip, f"touch /tmp/suno_render.lock; cd poc && nohup ../.venv/bin/python full_video.py out/song_{name}.mp3 --ref out/ref_{name}.png "
                f"--name {name} --bpm {bpm} --steps {steps} > out/full_{name}.log 2>&1 &", stream=False)
    last = ""
    while True:
        time.sleep(poll)
        tail = ssh(ip, f"tr '\\r' '\\n' < poc/out/full_{name}.log | grep -aE 'clip [0-9]+/|final video|Error|Traceback' | tail -1", stream=False).strip()
        if tail and tail != last:
            log(tail[:160]); last = tail
        alive = ssh(ip, "pgrep -f '[f]ull_video.py' >/dev/null && echo yes || echo no", stream=False).strip()
        if alive == "no":
            break
    ssh(ip, "rm -f /tmp/suno_render.lock", stream=False)
    dst = VIDEO / "poc" / "out" / "full" / name
    dst.mkdir(parents=True, exist_ok=True)
    for f in ("final.mp4", "plan.json"):
        subprocess.run(["scp", "-q", *SSH_OPTS, f"ubuntu@{ip}:{remote_out.replace('~/', '')}/{f}", str(dst / f)], check=False)
    subprocess.run(["scp", "-q", *SSH_OPTS, f"ubuntu@{ip}:{REMOTE_DIR.replace('~/', '')}/poc/out/full_{name}.log", str(dst / "remote.log")], check=False)
    log(f"pulled {dst / 'final.mp4'} ({(dst / 'final.mp4').stat().st_size // 1024 if (dst / 'final.mp4').exists() else 0} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["start", "stop", "status", "ssh", "setup", "render", "full", "run"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--bpm", type=float, default=120)
    ap.add_argument("--name", default="clip")
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--frames", type=int, default=81)
    ap.add_argument("--ref", default=None)
    ap.add_argument("--keep", action="store_true", help="do not stop the node afterwards")
    a = ap.parse_args()
    if a.cmd == "status":
        print(*state()); return
    if a.cmd == "stop":
        stop(); return
    ip = start()
    if a.cmd == "start":
        return
    if a.cmd == "ssh":
        os.execvp("ssh", ["ssh", *SSH_OPTS, f"ubuntu@{ip}"])
    try:
        if a.cmd == "setup":
            setup(ip)
        elif a.cmd == "run":
            ssh(ip, a.arg)
        elif a.cmd == "render":
            render(ip, a.arg, a.bpm, a.name, a.steps, a.ref, a.frames)
        elif a.cmd == "full":
            full(ip, a.arg, a.bpm, a.name, a.steps, a.ref)
    finally:
        if not a.keep and a.cmd in ("render", "full"):
            stop()


if __name__ == "__main__":
    main()
