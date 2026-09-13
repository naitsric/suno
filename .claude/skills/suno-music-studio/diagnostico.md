# Diagnóstico con números

Correr con `engine/voice/.venv/bin/python` desde `~/www/personal/Suno`. Importar
`server` desde `engine/voice` cambia el cwd a `seed-vc`: usar rutas absolutas.

## Tono: referencia vs voz de la canción

```python
import sys, numpy as np, librosa
sys.path.insert(0, "engine/voice"); import server
from pathlib import Path
prof = server.analyze_reference(Path("/abs/ruta/voz.wav"), "speech")   # o "singing"
print(prof["median_note"], prof["sing_low_note"], prof["sing_high_note"], prof["metrics"])
# voz de una canción: separar primero
voc, inst = server.separate(Path("/abs/ruta/cancion.raw.mp3 convertido a wav"), Path("/tmp/x"))
hz = server.f0_rmvpe(voc)              # necesita Seed-VC cargado (~60 s la primera vez)
print(np.percentile(hz, [10, 50, 90]))
```

Lectura: si p90 de la canción supera `sing_high_hz` de la referencia hablada, el
modelo extrapola y "se rompe". Con referencia cantada, comparar medianas.

## Calidad de una grabación

```python
import numpy as np, soundfile as sf, sys
sys.path.insert(0, "engine/voice"); import server
y, sr = sf.read("/abs/ruta.wav", dtype="float32", always_2d=True); y = y.mean(1)
frame = int(0.02*sr); env = np.array([np.sqrt(np.mean(y[i:i+frame]**2)) for i in range(0, len(y)-frame, frame)]) + 1e-9
db = 20*np.log10(env)
print("suelo", np.percentile(db, 10), "rango dinámico", np.percentile(db, 90)-np.percentile(db, 10))
print("hi/mid dB", server.hi_mid_db(y, sr))      # ≈ -8 cerca del micro; < -14 lejos/apagada
rev = server.dereverb_file(Path(ruta), Path("/tmp/dry.wav"), Path("/tmp"))   # dB del stem "reverb"; ≈ -50 = seca
```

Referencias medidas: Cris (buena) suelo −56 dB, hi/mid −8; Cris 2 (lejos del
micro) suelo −45 dB, hi/mid −17, reverb −42 dB.

## Integración de la voz convertida

```python
from scipy.ndimage import uniform_filter1d
env = lambda x: np.sqrt(uniform_filter1d(x.astype(np.float64)**2, size=5292))[::2205]
print(np.corrcoef(env(orig_mono), env(conv_mono))[0, 1])   # 0.95 sin glue, 0.997 con match_envelope
```

## Validar un cambio de la cadena ffmpeg

Medir `hi_mid_db` y suelo antes/después de cada filtro por separado
(`ffmpeg -i in.wav -af <filtro> -ar 44100 out.wav`). Recordar `-ar`: `loudnorm`
sube a 192 kHz y arruina la medición.

## Reproducir una conversión fuera de la biblioteca

```bash
curl -s -F song=@web/data/audio/<id>.raw.mp3 -F reference=@web/data/voices/<voz>.wav \
  -F auto_octave=false -F ref_kind=singing -F key_scale="G minor" http://127.0.0.1:8002/convert
# poll GET /jobs/<job_id>; luego GET /jobs/<job_id>/audio > prueba.mp3 y mandarlo al usuario
```

Sirve para A/B (con/sin octava, con/sin autotune, otra referencia) sin tocar
la biblioteca del usuario.

## Textura de una voz convertida (¿metálica?)

`scripts/measure_stems.py` (correr con `engine/voice/.venv/bin/python`; Demucs en CPU,
no toca la GPU del servicio):

```bash
python scripts/measure_stems.py raw  web/data/audio/<id>.raw.mp3          # separa y mide
python scripts/measure_stems.py conv web/data/audio/<id>.voice.raw.mp3 --ref raw
# stems ya separados (p. ej. keep_stems=true en /convert): --no-sep
python scripts/measure_stems.py conv <job>/vocals_converted.wav --no-sep --ref <label>
```

Métricas sobre los frames fuertes del stem: `hi_mid_db` (3–7 k vs 0.3–3 k), `hf8k_db`,
`flat_3_7k` (planitud de la banda de presencia: más alto = más ruido), `hnr_db` (HPSS),
`cpp` (prominencia cepstral), y con `--ref`: `env_corr`, `f0_corr_st`, `f0_med_abs_dev_st`,
`lsd_*` por banda y `mel_lsd` (distancia log-mel por frame, quitado el nivel; suelo de
la métrica 0.9 dB entre Demucs MPS y CPU). Valores de la conversión identidad de
Valentín: stem original hi/mid −18.2, flat 0.18, HNR 13.6; Seed-VC −12.3, 0.25, 10.9,
mel_lsd 6.9. Para un A/B rápido, cortar 75 s con el coro (`ffmpeg -ss 90 -t 75`), pasar
el clip por `/convert` con `keep_stems=true` y medir `vocals_converted.wav` contra
`vocals.wav` del mismo job (~3 min por variante en vez de 10).
