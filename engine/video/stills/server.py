"""Stills video service: a sequence of Pixar-style images for a song, assembled into a Ken Burns video.

REST API (port 8003):
  GET  /health                     {status, device, free_gb, busy, queued}
  POST /videos                     multipart: audio, storyboard (JSON), [reference], [images...], [width], [height], [steps], [seed], [fps]
                                   images = pre-rendered scenes (e.g. from OpenAI), one per storyboard scene, in order:
                                   then nothing is rendered here, only the assembly runs
                                   storyboard = {"character": str, "scenes": [{"prompt": str, "duration": float}, ...],
                                                 "lyrics": [{"text", "start", "end", "words": [...]}]  (optional, burned as karaoke)}
  GET  /videos/{id}                {status: queued|waiting|rendering|assembling|done|failed, stage, done, total, error}
  GET  /videos/{id}/video          mp4
  GET  /videos/{id}/images/{n}     scene PNG (1-based)
  POST /portrait                   multipart: prompt, [steps], [seed] → PNG

One heavy job at a time (`_gpu_lock`). Before loading the models the worker waits until the machine has
~12 GB available (the music engine and the voice service are usually resident): the stage text tells
the user what to stop. The pipeline is released after each job.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Optional

import psutil
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

HERE = Path(__file__).resolve().parent
WORK = Path(os.environ.get("STILLS_WORK_DIR", HERE / ".cache" / "jobs"))
WORK.mkdir(parents=True, exist_ok=True)
# psutil's "available" on macOS is conservative (it ignores the compressor and purgeable memory): the
# 832x480 single-frame render (peak 15.5 GB MPS) completed fine at ~7 GB "available" once Ollama's runner
# was stopped, and swapped badly below ~4 GB with engine + voice + Ollama resident.
MIN_FREE_GB = float(os.environ.get("STILLS_MIN_FREE_GB", "6"))
_gpu_lock = threading.Lock()
_busy = False


@dataclass
class Job:
    id: str
    dir: Path
    audio: Path
    storyboard: dict
    width: int = 832
    height: int = 480
    steps: int = 25
    seed: int = 7
    fps: int = 24
    reference: Optional[Path] = None
    external: bool = False  # scenes were uploaded, skip rendering
    status: str = "queued"
    stage: str = "En cola"
    done: int = 0
    total: int = 0
    error: Optional[str] = None
    output: Optional[Path] = None
    images: list = field(default_factory=list)
    created_at: float = field(default_factory=time.time)


jobs: dict[str, Job] = {}
queue: "Queue[Job]" = Queue()


def free_gb() -> float:
    return psutil.virtual_memory().available / 2**30


def wait_for_memory(job: Job, timeout_s: float = 30 * 60) -> None:
    t0 = time.time()
    while free_gb() < MIN_FREE_GB:
        job.status, job.stage = "waiting", f"Esperando memoria libre ({free_gb():.1f} GB, necesita {MIN_FREE_GB:.0f}): apaga el motor (:8001), la voz (:8002) u Ollama"
        if time.time() - t0 > timeout_s:
            raise RuntimeError("Sin memoria suficiente para renderizar (apaga el motor o el servicio de voz)")
        time.sleep(10)


def run_job(job: Job) -> None:
    global _busy
    import render
    import slideshow

    try:
        scenes = job.storyboard["scenes"]
        if job.external:
            job.status, job.stage = "rendering", "Imágenes recibidas"
            job.images = sorted((job.dir / "scenes").glob("scene_*.png"))
            if len(job.images) != len(scenes):
                raise RuntimeError(f"Se recibieron {len(job.images)} imágenes para {len(scenes)} escenas")
            job.done = job.total = len(job.images)
        else:
            wait_for_memory(job)
        with _gpu_lock:
            _busy = True
            if not job.external:
                job.status = "rendering"
                character = job.storyboard.get("character", "")
                style = job.storyboard.get("style", "")
                prompts = [render.full_prompt(s["prompt"], character, style) for s in scenes]
                job.total = len(prompts)

                def progress(i, n, _stage):
                    job.done, job.stage = i, f"Imagen {i + 1} de {n}"

                job.stage = "Codificando descripciones"
                try:
                    job.images = render.render_scenes(prompts, job.dir / "scenes", job.width, job.height, job.steps, job.seed, job.reference, progress)
                finally:
                    render.release_pipe()
                job.done = job.total
            job.status, job.stage = "assembling", "Montando el video"
            durations = [float(s["duration"]) for s in scenes]
            total = float(job.storyboard.get("total", sum(durations)))
            out = job.dir / "video.mp4"
            subs = None
            lyrics = job.storyboard.get("lyrics")
            if lyrics:
                import subtitles as subs_mod

                subs = subs_mod.write_ass(lyrics, job.dir / "lyrics.ass")
            slideshow.build(job.images, durations, job.audio, out, fps=job.fps, total=total, subtitles=subs)
            job.output, job.status, job.stage = out, "done", "Listo"
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        job.status, job.error, job.stage = "failed", f"{type(exc).__name__}: {exc}", "Error"
    finally:
        _busy = False


def worker() -> None:
    while True:
        job = queue.get()
        run_job(job)
        queue.task_done()


threading.Thread(target=worker, daemon=True).start()
app = FastAPI(title="Suno Local stills video service")


@app.get("/health")
def health():
    import render  # puts poc/ on sys.path

    return {"status": "ok", "device": render.common.DEVICE, "free_gb": round(free_gb(), 1), "min_free_gb": MIN_FREE_GB, "busy": _busy, "queued": queue.qsize()}


@app.post("/videos")
async def create_video(
    audio: UploadFile = File(...),
    storyboard: str = Form(...),
    reference: Optional[UploadFile] = File(None),
    images: list[UploadFile] = File([]),
    width: int = Form(832),
    height: int = Form(480),
    steps: int = Form(25),
    seed: int = Form(7),
    fps: int = Form(24),
):
    try:
        sb = json.loads(storyboard)
        assert isinstance(sb.get("scenes"), list) and sb["scenes"], "storyboard.scenes vacío"
        for s in sb["scenes"]:
            assert s.get("prompt") and float(s.get("duration", 0)) > 0, "cada escena necesita prompt y duration"
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"storyboard inválido: {exc}") from exc
    job_id = str(uuid.uuid4())
    job_dir = WORK / job_id
    job_dir.mkdir(parents=True)
    audio_path = job_dir / f"audio{Path(audio.filename or 'song.mp3').suffix or '.mp3'}"
    with audio_path.open("wb") as f:
        shutil.copyfileobj(audio.file, f)
    ref_path = None
    if reference is not None and reference.filename:
        ref_path = job_dir / f"reference{Path(reference.filename).suffix or '.png'}"
        with ref_path.open("wb") as f:
            shutil.copyfileobj(reference.file, f)
    external = False
    if images:
        scenes_dir = job_dir / "scenes"
        scenes_dir.mkdir()
        for i, up in enumerate(images):
            with (scenes_dir / f"scene_{i + 1:02d}.png").open("wb") as f:
                shutil.copyfileobj(up.file, f)
        external = True
    job = Job(id=job_id, dir=job_dir, audio=audio_path, storyboard=sb, width=width, height=height, steps=max(8, min(steps, 50)), seed=seed, fps=max(12, min(fps, 30)), reference=ref_path, external=external, total=len(sb["scenes"]))
    jobs[job_id] = job
    queue.put(job)
    return {"job_id": job_id, "status": job.status, "queue_position": queue.qsize()}


@app.get("/videos/{job_id}")
def video_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {"job_id": job.id, "status": job.status, "stage": job.stage, "done": job.done, "total": job.total, "error": job.error}


@app.get("/videos/{job_id}/video")
def video_file(job_id: str):
    job = jobs.get(job_id)
    if not job or job.status != "done" or not job.output:
        raise HTTPException(404, "video not ready")
    return FileResponse(job.output, media_type="video/mp4", filename="video.mp4")


@app.get("/videos/{job_id}/images/{n}")
def scene_image(job_id: str, n: int):
    job = jobs.get(job_id)
    path = job.dir / "scenes" / f"scene_{n:02d}.png" if job else None
    if not path or not path.exists():
        raise HTTPException(404, "image not ready")
    return FileResponse(path, media_type="image/png")


@app.post("/portrait")
def portrait(prompt: str = Form(...), steps: int = Form(30), seed: int = Form(1)):
    import render

    out = WORK / f"portrait-{uuid.uuid4()}.png"
    try:
        wait_for_memory(Job(id="portrait", dir=WORK, audio=WORK, storyboard={}), timeout_s=60)
        with _gpu_lock:
            try:
                render.render_portrait(render.full_prompt("", prompt), out, steps=steps, seed=seed)
            finally:
                render.release_pipe()
        data = out.read_bytes()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        out.unlink(missing_ok=True)
    return Response(content=data, media_type="image/png")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("STILLS_HOST", "127.0.0.1"), port=int(os.environ.get("STILLS_PORT", "8003")))
