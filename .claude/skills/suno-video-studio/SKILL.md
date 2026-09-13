---
name: suno-video-studio
description: Generar videos musicales estilo Pixar para las canciones de Suno Local (~/www/personal/Suno) con modelos locales — Wan 2.1 VACE (imagen de referencia + control de pose OpenPose) en engine/video, con personajes consistentes por artista, sin tumbar el Mac de 24 GB en el intento. Usar cuando pidan "hazle un video a la canción", "video 3D/Pixar del artista", "clip para X", "retrato del artista", "el render va lento / se colgó / se quedó sin memoria", "reanuda el render", "decodifica los latentes", "cuánto cuesta un video", "alquilo una GPU", o cualquier cambio en engine/video/. Cargarla ANTES de lanzar nada: cada trampa de aquí costó entre una hora y una noche de render perdida.
---

# Suno Video: clips Pixar con personajes consistentes, en local

Un solo entorno, separado de la música: `engine/video/.venv` (uv, py3.12, torch
MPS + diffusers ≥ 0.35). Scripts en `engine/video/poc/`. Modelo:
`Wan-AI/Wan2.1-VACE-1.3B-diffusers` (~18 GB en la caché de HF). Salidas en
`engine/video/poc/out/`. Números medidos y experimentos en [mediciones.md](mediciones.md).

**Regla cero: el render necesita la GPU y la memoria SOLAS.** Antes de lanzar:

```
curl -s -m 2 -o /dev/null -w "%{http_code}\n" localhost:8001/health   # ACE-Step: 000 = apagado, bien
curl -s -m 2 -o /dev/null -w "%{http_code}\n" localhost:8002/health   # voz: idem
curl -s localhost:11434/api/ps                                        # Ollama: {"models":[]} bien
memory_pressure | tail -1                                             # >70 % libre antes de empezar
```

ACE-Step (19 GB) y el servicio de voz (14 GB) siguen residentes aunque estén
ociosos. Con el render encima llenaron 42 GB de swap y cada paso pasó de 70 s a
20–120 min. No basta un lock de GPU: hay que apagarlos (`kill` de `acestep-api`,
`voice/server.py` y su wrapper `uv run`; se relanzan con `make dev`) o pedir al
usuario que lo haga. Ollama: `ollama stop <modelo>`; `keep_alive: 0` NO libera
el runner.

## Reels rápidos de un álbum (sin GPU): `engine/video/stills/reel.py`

Cuando pidan "reels de las canciones de X" o "un clip corto para redes", NO hace
falta Wan: `reel.py --album "NOMBRE"` hace un vertical de ~25 s por canción con
portada, título y letra karaoke en ~6 s de render. Necesita el servicio de voz
encendido solo para alinear letras la primera vez (`make voice`, luego apagarlo).
Detalles en el README del repo, sección "Reels de un álbum". Los artistas viven en
SQLite (`web/data/suno.db`); "Sebas Marea" es el artista y "Las cosas sencillas"
su álbum (6 canciones). Verificar siempre con frames que no haya líneas apiladas
ni tramos de letra "apretados" (líneas de 0,2-0,5 s = alineación mala).

## Modelo mental

1. **El 3D no renderiza, solo dirige.** El "esqueleto" del plano (pose, cámara,
   ritmo) es un video de control OpenPose; la imagen la pone el modelo de
   difusión con estilo Pixar en el prompt. Blender con rigs gratis parece un
   videojuego de 2015 y los rigs CC-BY de Blender Studio no son tu artista:
   descartados.
2. **La identidad la da la imagen de referencia**, no el prompt. Se genera UNA
   vez por artista (VACE con `num_frames=1` funciona como generador de retratos,
   sin Flux) y se inyecta en cada clip. Con 1.3B la cara aguanta en plano
   cerrado y se pierde en plano medio: encuadrar cerca si importa la identidad.
3. **El movimiento sale del audio.** Beats con librosa sobre el segmento
   (por defecto la ventana de 5 s más fuerte = coro), bob en cada beat, puño en
   el tiempo fuerte del compás, balanceo por compás. Un video de 3 min son ~36
   clips de 5 s cortados al beat.
4. **Todo es por lotes y nocturno.** Un clip son ~45 min en el M5 Pro con la
   GPU sola; no es interactivo. Por eso el pipeline guarda estado en cada paso.

## Flujo de un clip

```
cd ~/www/personal/Suno/engine/video/poc
P=../.venv/bin/python
$P pose_control.py <audio.mp3> --bpm <bpm> [--start s] [--frames 81 --fps 16 --width 832 --height 480]
$P ref_image.py --n 3 --steps 30            # 3 retratos 832x480, ~40 s cada uno; elegir uno con Read
nohup $P generate.py --ref out/ref_1.png --steps 30 --name clip_v1 > out/clip_v1.log 2>&1 &
pgrep -f generate.py > out/clip_v1.pid
```

`generate.py` hace: embeddings UMT5 (una vez, caché en `poc/cache`), encode del
control y la referencia con el VAE en **bf16**, 30 pasos con checkpoint por
paso, latentes finales a `out/<name>_latents.pt`, decode en **CPU con tiles de
128 px**, mux del segmento de audio con ffmpeg → `out/<name>.mp4`. Los prompts
(estilo, personaje) están dentro de `ref_image.py` y `generate.py`; cambiarlos
ahí por artista.

Reanudar tras un corte: **el mismo comando**. Detecta `out/<name>_ckpt.pt`,
recorta los timesteps del scheduler y sigue desde ese paso (verificado: matado
en el 2, retomó en el 3; UniPC pierde 2–3 pasos de historial, efecto mínimo).
`--fresh` ignora el checkpoint; `--decode-only` solo decodifica los latentes
guardados. Cambiar `--steps`, `--frames` o `--seed` invalida el checkpoint.

Revisar el resultado sin abrir el video:

```
ffmpeg -y -v error -i out/clip_v1.mp4 -vf "select='not(mod(n\,16))'" -vsync vfr out/frames/f%02d.png
# luego xstack de 6 frames o Read de cada png
```

## Cómo vigilar un render (y no matarlo por error)

- Lanzar con `nohup ... &` y pidfile. **El harness de Claude Code mata los
  comandos de fondo cuando el sistema tiene poca memoria**; un `run_in_background`
  normal murió así a las 03:00 durante el decode.
- Leer el log con `tr '\r' '\n' < out/clip_v1.log | grep -E "step [0-9]+/30|decod|wrote|Error"`.
  Las barras tqdm dejan las líneas del log sin salto previo: un grep anclado a
  `^\[` no ve nada y parece que el proceso está muerto.
- Un proceso MPS a 0 % de CPU y RSS pequeño está esperando a la GPU, no colgado.
  Se mató uno sano por esto. Si hace falta confirmar: `sample <pid> 1` muestra
  `copy_and_sync` / kernels Metal.
- Ritmo sano en el M5 Pro: 69–71 s por paso a 832×480×81. Si un paso pasa de 3
  min, mirar `sysctl vm.swapusage` y `top -l 1 -o mem`: algo ajeno entró en
  memoria.
- Tras matar un render esperar ~10 s antes de lanzar otro: la GPU tarda en
  liberar; lanzado a los 3 s el siguiente se quedó en la primera copia a MPS.
- Monitor útil: bucle que imprime la última línea `step N/30` y `memory_pressure`
  cada 10 s mientras el pid viva.

## Trampas de memoria (todas pasaron)

| Síntoma | Causa | Arreglo aplicado |
|---|---|---|
| OOM en el encode del VAE (14.7 GB) | encode fp32 de 81 frames | `pipe.vae.to(bfloat16)` antes de `pipe(...)` |
| Decode en MPS falla con "other allocations ~15 GB" con CUALQUIER tile/dtype | conv3d en Metal reserva ~15 GB fuera del pool | decode en CPU |
| Decode en CPU sube a 32 GB y muere en swap | im2col de conv3d a 832×480 (~16 GB por chunk de 4 frames) | tiles de 128 px, stride 96 → 3.5 GB planos, 596 s |
| Paso 1 a 77 s, luego 20 min | otros modelos residentes + swap lleno | apagar ACE-Step/voz/Ollama; `PYTORCH_MPS_HIGH_WATERMARK_RATIO=1.0` para fallar rápido en vez de arrastrar la máquina |
| Atención de 32k tokens OOM | SDPA de MPS materializa QK | `common.py` trocea las queries (`_CHUNK_BUDGET`) |
| `enable_tiling()` del VAE con tiles por defecto OOM en el encode | tiles de 256 + memoria ajena | no usar tiling en el encode; solo en el decode CPU |
| El decode produce 85 frames | VACE añade 1 frame latente para la referencia | `latents[:, :, 1:]` antes de decodificar |

## Costo y hardware (para decidir, no para impresionar)

- M5 Pro 24 GB, GPU sola: retrato 39 s; denoising 35 min; decode CPU 10 min →
  **~45 min por clip de 5 s, ~27 h por video de 3 min**.
- Otro Mac: M4 base 16 GB no cabe (solo UMT5 pesa 11 GB); M4 Pro 48/64 GB ~1 h
  por clip pero aislado y sin swap; M4 Max ≈ M5 Pro. Ningún Apple Silicon cambia
  el orden de magnitud.
- GPU NVIDIA (local o alquilada): 4090 ~2–3 min por clip; H100 ~1 min. Con 48–80
  GB se puede usar **VACE 14B**, que conserva la cara mucho mejor y genera 720p
  (~10 min por clip en H100). Proveedores: RunPod (más cómodo, por segundo,
  volúmenes de red, API para encender/apagar), Vast.ai (más barato, fiabilidad
  variable), Lambda (sólido, H100 escaso), AWS `g6e` L40S si se quiere quedar en
  la cuenta existente (cuotas, más caro; A100/H100 solo en paquetes de 8).
- En cloud los pods son efímeros y los spot se interrumpen: el checkpoint por
  paso deja de ser lujo. Pesos en volumen persistente.

## Diseño del servicio (:8003) cuando salga del PoC

- FastAPI + cola + lock, como el de voz, pero además **descarga o exige apagados
  los otros modelos** antes de rendear.
- Entrada desacoplada de la generación: cualquier canción hecha (`<id>.mp3`),
  letra, artista y su retrato. Retrato = campo del artista, igual que `defaultVoiceId`.
- Plan de escenas como JSON editable antes de rendear (escenas, duración,
  cámara, mood), coherente con la regla de la plataforma: nada automático sin
  revisión (`feedback-opt-in-processing`).
- Lip-sync en primeros planos con el stem vocal de Demucs (LatentSync o similar)
  como capa posterior, no dentro del render.
- Alineación de letra con mlx-whisper para versos en pantalla y cortes.

## Comprobación mínima antes de decir "listo"

1. `ffprobe` del mp4: 81 frames, 16 fps, 5.06 s, pista de audio presente.
2. Hoja de 6 frames revisada con Read: personaje consistente, sin manos fundidas,
   pose siguiendo el control.
3. `out/<name>.json` / `_decode.json` con tiempos por paso y del decode, para
   comparar contra las mediciones de referencia.
4. Servicios del usuario: decir explícitamente si quedaron apagados y cómo
   relanzarlos (`make dev`).

## Nodo de render on-demand en AWS (existe desde 2026-09-08)

Instancia **parada, no destruida**: `i-00b74d4deaa496fd0`, g6e.2xlarge (L40S
46 GB, 61 GB RAM), us-east-1b, cuenta del perfil `default`. Ids en
`engine/video/.instance_id` / `.sg_id`; llave `~/.ssh/suno-video-render.pem`.
Parada cuesta solo el EBS de 150 GB (~12 USD/mes); encendida 2.24 USD/h.

```
cd ~/www/personal/Suno/engine/video
python3 cloud/remote.py status                      # stopped | running + IP
python3 cloud/remote.py render <mp3> --bpm 128 --ref poc/out/ref_1.png --name clip_x [--steps 30] [--keep]
python3 cloud/remote.py stop                        # siempre al terminar si usaste --keep
```

`render` arranca el nodo, sube `poc/` y `cloud/`, corre pose_control →
generate, baja `poc/out/remote/<name>.mp4` y **para el nodo**. Dos redes de
seguridad por si el Mac muere a mitad: cron `idle_watchdog.sh` en el nodo
(apaga tras 15 min sin lock, sin GPU y sin procesos de render) y la alarma
CloudWatch `suno-video-render-idle-stop` (CPU < 5 % 30 min → stop).

Medido en la L40S: 30 pasos de 81 frames 832×480 = **208 s** (~7 s/paso,
10× el Mac), decode en GPU 10 s, clip completo 256 s ≈ 0.16 USD; video de 3
min ≈ 1.3 h ≈ 3 USD. Mismo seed → resultado visualmente idéntico al del Mac.

Trampas ya resueltas: la IP pública del usuario sale por un pool NAT
(206.62.142.0/24), una regla /32 no sirve; openrsync de macOS no acepta
`--info=progress2` ni expande globs remotos (bajar con scp y nombres
explícitos); la DLAMI no trae ffmpeg (`setup_remote.sh` lo instala y `mux()`
cae a imageio-ffmpeg). Con 46 GB cabe VACE 14B: es el siguiente experimento
para recuperar la identidad de la cara.

> **Estado 2026-09-08:** el nodo de AWS descrito arriba fue ELIMINADO al cerrar el PoC
> (instancia, disco, alarma, SG y key pair). Los scripts de `cloud/` siguen siendo válidos,
> pero hay que crear una instancia nueva (g6e.2xlarge, DLAMI PyTorch, 250 GB gp3) y correr
> `remote.py setup` antes de usarlos. Conclusiones del PoC: VACE 14B conserva la cara del
> retrato (1.3B no); costo 14B ≈ 15 min/clip en L40S; S2V-14B quedó sin probar (faltaban
> `einops` y `requirements_s2v.txt` en el entorno del repo oficial).
