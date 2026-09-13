# Mediciones y experimentos (M5 Pro, 24 GB, macOS 25.5, torch 2.14, diffusers ≥ 0.35)

Primer clip: Tokio, "Cenizas y Fuego" (`eb407749…`), segmento 200.8 s (coro
final, ventana RMS más fuerte), 81 frames 832×480 @16 fps, 30 pasos UniPC,
flow_shift 3.0, guidance 5.0, conditioning_scale 1.0, seed 7, referencia `ref_1.png`.

## Tiempos con la GPU sola

| Etapa | Tiempo | Memoria |
|---|---|---|
| Embeddings UMT5-XXL (se libera después) | ~10 s | 11 GB durante el encode |
| Carga transformer 1.3B + VAE | 5 s | 5.1 GB |
| Retrato 832×480, 1 frame, 30 pasos | 39–41 s | pico 15.4 GB (driver) |
| Encode control + referencia (VAE bf16) | ~50 s | incluido en el paso 1 |
| Paso de denoising 81 frames | 66–71 s | alloc 4.8 GB, driver 7.1 GB |
| 30 pasos | ~35 min | |
| Decode CPU fp32, tiles 128/stride 96 | 596 s | RSS 2.6–3.5 GB plano |

## Lo que se probó para el decode y falló

- MPS fp32 sin tiling: OOM (8.9 GB pool + 8.3 GB "other").
- MPS fp32 tiles 128, bf16 tiles 128, bf16 tiles 256: todos OOM con "other
  allocations" 13.7–15.7 GB en los primeros 20 s, independiente de dtype y tile.
  `decode_probe.py`: una llamada del decoder a un tile 128 de 4 frames sube el
  driver 1.3 GB; en CPU 0.8 s y +1.8 GB RSS.
- CPU con tiles 256 (default de `enable_tiling`): RSS 11 GB a los 24 s y
  32 GB después → swap lleno, proceso "stuck".
- CPU tiles 128: 45 tiles (5×9) × 21 frames latentes ≈ 10 min, memoria plana.

## Cronología de la noche perdida (2026-09-07/08)

- 21:52 primer render: 4 min de encode, 77 s/paso. Compartía la máquina con
  ACE-Step, voz y gemma (10.4 GB en GPU).
- 22:04 relanzado tras apagar gemma; 11 pasos a 70 s; del paso 12 al 15 subió a
  20 min/paso: swap 41/42 GB. ACE-Step 19 GB + voz 14 GB residentes.
- 23:57 el usuario apagó ambos servicios: 13 pasos en 14 min. A las 00:05 volvió
  a frenarse (paso 29 = 65 min, paso 30 = 1 h 52) sin ningún servicio ajeno.
  Causa no identificada; el propio proceso rondaba 15 GB (pool MPS sin límite,
  ratio por defecto 1.7 → "max allowed 30 GB" en una máquina de 24).
- 03:04 terminó el denoising y el harness mató el proceso en el decode por
  memoria baja. Sin latentes guardados: todo perdido.
- 09:08 → 10:16 render definitivo con las protecciones actuales.

## Calidad observada en el clip

Look CGI Pixar convincente (piel, ojos, luces con bokeh); pelo, chaqueta y
micrófono constantes en los 81 frames; pose obedecida (mic a la boca, puño en el
tiempo fuerte). Cara pequeña y poco detallada en plano medio; identidad respecto
al retrato solo parcial. Pendiente: plano cerrado, 20 pasos, `--cond` < 1,
VACE 14B en GPU NVIDIA.
