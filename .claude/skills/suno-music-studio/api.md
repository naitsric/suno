# Referencia rápida de la API (web :3000 y servicio de voz :8002)

Todo JSON salvo donde dice multipart. Los IDs son UUID. La base es SQLite en
`web/data/suno.db` (drizzle; migraciones aditivas en `web/src/db/index.ts`,
corren en cada carga del módulo).

## Web (:3000)

| Método y ruta | Cuerpo | Notas |
|---|---|---|
| `GET /api/engine` | — | estado de motor, Ollama y servicio de voz |
| `POST /api/artists` | `{name, emoji?, style?, description?, vocalLanguage?}` | `style` con tags en inglés y género vocal |
| `PATCH /api/artists/[id]` | `{name?, emoji?, style?, description?, vocalLanguage?, defaultVoiceId?}` | `defaultVoiceId` debe ser una voz del artista |
| `POST /api/artists/[id]/albums` | `{name}` | |
| `GET /api/songs?artist=<id\|none>` | — | **sincroniza** motor y voz; pollearlo cada 10 s |
| `POST /api/songs` | `{mode: simple\|custom, title?, description?, style?, lyrics?, instrumental, duration?, vocalLanguage, model?, voiceId?, autotune?, voiceOptions?, variants? (1–6), voiceMatchId?, useLora?, master, artistId?, albumId?, bpm?, keyScale?}` | 2 variantes por creación; devuelve `songs[]` con `style`/`lyrics` ya escritos |
| `PATCH /api/songs/[id]` | `{title?, artistId?, albumId?}` | |
| `DELETE /api/songs/[id]` | — | **no cancela** la tarea del motor |
| `GET /api/songs/[id]/audio?original\|raw&download` | — | `original` = mezcla anterior a la conversión; `raw` = crudo activo (puede ser convertido); crudo del modelo = `<id>.raw.mp3` |
| `POST /api/songs/[id]/master` | `{enhance, preset}` | presets en `master-presets.ts`; `off` = crudo |
| `POST /api/songs/[id]/edit` | `{instruction, start?, end?, plan?}` | sin `plan` devuelve el plan (Ollama); con `plan` (`op, style, lyrics, strength, start, end, summary`) lo ejecuta y crea una fila nueva |
| `POST /api/songs/[id]/voice-match` | `{voiceId}` | mide el parecido del cantante (crudo) con esa voz; `voiceSimilarity` llega en un poll posterior |
| `POST /api/artists/[id]/lora` / `GET` / `DELETE` | `{epochs?, rank?, minSongs?}` | entrena / consulta / para el LoRA del artista en ACE-Step (`lib/lora.ts`); `GET` → `{status, path, progress, error, tag, songs, running, training}` |
| `POST /api/songs/[id]/voice` | `{voiceId?, autotune?, options?}` | reconvierte desde `<id>.raw.mp3`; pasa a `converting`. `options` (JSON en `songs.voice_options`, `web/src/lib/voice-options.ts`): `diffusionSteps, cfgRate, refDenoise, refSeconds, glueSpectrumDb, glueReverb, enhanceVocals, deharshDb`; `null` = valores del servicio; omitido = conserva los guardados |
| `DELETE /api/songs/[id]/voice` | — | quita la voz convertida (borra `<id>.voice.*`, vuelve a `<id>.mp3`); vale aunque esté `converting` |
| `GET /api/voices?artist=<id>` | — | rellena perfiles que falten (best effort) |
| `POST /api/voices` | multipart `audio`, `name`, `artistId?` | grabación hablada → WAV mono 44.1k + análisis |
| `POST /api/voices/from-song` | `{songId, name?}` | voz cantada sintética; pasa a ser default del artista |
| `GET /api/voices/[id]?original\|clean` | — | audio de la referencia activa / original / retocada |
| `PATCH /api/voices/[id]` | `{name?, artistId?, register?, useClean?}` | `register` ∈ bass, baritone, tenor, alto, mezzo-soprano, soprano |
| `POST /api/voices/[id]/analyze` | — | re-mide el perfil (error si el servicio está apagado) |
| `POST /api/voices/[id]/clean` | — | retoque de la grabación; devuelve `{voice, info}` |
| `POST /api/voices/[id]/sculpt` | `{formant, pitch, brightness}` | esculpe el timbre (formantes %, semitonos, dB de aire); `{voice, info}` con F0 y centroide antes/después; `PATCH {useSculpt}` alterna; `GET ?sculpt` la oye |
| `DELETE /api/voices/[id]` | — | borra original y retocada |
| `POST /api/lyrics` | `{description, language, instrumental, voiceId?}` | borrador título/estilo/letra para modo custom |
| `POST /api/reference` | `{url, artistId?, refresh?, token?}` | analiza un video de YouTube (`:8002/reference-analysis`, 1–3 min, caché 30 d) y devuelve `{analysis, prompt{style, caption, summary, structure, bpm, keyScale, source}, cached}`; `GET ?token=` da la etapa |
| `POST /api/market/ideas` / `ask` | `{country, artistId?, refresh?}` / `{…, question}` | Ollama, ~4 min; caché en `kv_cache` |

Estados de `songs.status`: `queued → generating → (converting) → done | failed`.
`progress` lleva el texto de etapa (`🎤 …` durante la conversión). Archivos:
`<id>.raw.mp3` (crudo del modelo, nunca se toca), `<id>.mp3` (post-producido),
`<id>.voice.raw.mp3` / `<id>.voice.mp3` (con voz convertida).

Columnas útiles de `voices`: `kind` (speech|singing), `sourceSongId`, `register`,
`f0MedianHz`, `singLowHz/HighHz`, `profile` (JSON completo del análisis),
`cleanFile`, `useClean`.

## Crear conservando la identidad vocal y naturalidad

Leer primero `GET /api/artists` y `GET /api/voices?artist=<id>`; resolver la referencia
fija `defaultVoiceId` y verificar que pertenece al artista. Después pedir el borrador con
`POST /api/lyrics {description, language, instrumental: false, voiceId: <defaultVoiceId>}`
(no encola nada) y **revisarlo**: ACE-Step canta toda línea que no sea una etiqueta
`[Sección]`, así que las acotaciones tipo "Guitarras limpias y tensas" o "(Casi hablado)"
salen cantadas. Ejemplo de cuerpo para `POST /api/songs` con la letra ya corregida
(reemplazar los IDs con los consultados):

```json
{
  "mode": "custom",
  "title": "Título revisado",
  "style": "tags en inglés del borrador, revisados",
  "lyrics": "[Verse 1]\n… letra revisada, sin acotaciones …",
  "artistId": "ID_DEL_ARTISTA",
  "voiceMatchId": "DEFAULT_VOICE_ID_DEL_ARTISTA",
  "voiceId": null,
  "voiceOptions": null,
  "autotune": false,
  "master": "off",
  "useLora": false,
  "variants": 4,
  "instrumental": false,
  "vocalLanguage": "es"
}
```

`variants: 4` es el lote sugerido, ajustable al alcance autorizado. El modo `simple`
(con `description` en vez de `title`/`style`/`lyrics`) escribe la letra en la misma llamada
que encola la generación: si sale mal, el lote ya está pagado y `DELETE /api/songs/[id]` no
cancela la tarea del motor. `voiceMatchId` usa el
perfil para orientar el registro y luego mide el crudo; `voiceId` activaría conversión.
`artistId` por sí solo no aplica referencia ni LoRA. Activar `useLora` únicamente con un
LoRA del artista listo, disponible y validado por oído. Consultar estado con
`GET /api/artists/[id]/lora`; no entrenar como efecto secundario de crear una canción.

Seguir el GET de canciones después de `done` hasta obtener `voiceSimilarity`. Seleccionar
por score y oído frente a la referencia fija; no interpretar 0,8 como identidad garantizada.
Sin score o escucha, declarar qué validación falta. Un lote sin tomas consistentes no se
arregla cambiando la referencia ni convirtiendo automáticamente; reportar el resultado.
Las ediciones no heredan el score ni `voiceMatchId`: solicitarlo otra vez al terminar.

## Servicio de voz (:8002, FastAPI, multipart)

| Ruta | Campos | Devuelve |
|---|---|---|
| `GET /health` | — | `{status, device, models_loaded, apollo_loaded, queued}` |
| `POST /analyze` | `audio`, `kind=speech\|singing` | perfil: `median_hz, p10_hz, p90_hz, register, sing_low/high_*`, `metrics{centroid_hz, flatness, low_mid_db, intonation_st, pitch_step_st, rms_db_std}` |
| `POST /sculpt-reference` | `audio`, `formant_pct`, `pitch_st`, `brightness_db` | WAV; cabecera `X-Sculpt-Info` con F0 y centroide antes/después (CPU, sin `_gpu_lock`) |
| `POST /clean-reference` | `audio` | WAV; cabecera `X-Clean-Info` con `demucs, reverb_removed_db, strong_denoise, presence_boost, noise_floor_*, hi_mid_*` |
| `POST /extract-reference` | `audio` (canción), `seconds` | WAV de 30 s de la voz; `X-Extract-Info {start_sec, end_sec, sung_density}` |
| `POST /enhance` | `audio` | WAV restaurado con Apollo |
| `POST /reference-analysis` | `url` (YouTube) o `audio`, `token?` | JSON: `bpm, key, key_confidence, loudness_dbfs, dynamic_range_db, structure[], stems{}, vocals{present, pitch, language, transcript_snippet}, tags{genres, moods, instruments, vocals, production}, timings` (`reference.py`) |
| `GET /reference-analysis/{token}` | — | `{stage}` mientras corre |
| `POST /voice-similarity` | `audio` (canción o stem), `reference` (voz), `is_stem` | `{similarity, seconds}`: coseno CAMPPlus; orienta el parecido, no garantiza identidad. Umbrales de canto no se trasladan a habla |
| `POST /convert` | `song`, `reference`, `pitch_shift`, `diffusion_steps` (30), `auto_octave`, `autotune`, `autotune_strength`, `key_scale`, `ref_kind`, `cfg_rate` (0.7), `ref_denoise`, `ref_seconds` (30), `glue_spectrum_db` (8; 0 = sin EQ), `glue_reverb`, `enhance_vocals`, `deharsh_db` (0), `keep_highs_hz` (0 = sin híbrido), `keep_stems` | `{job_id, queue_position}` |
| `GET /jobs/{id}` | — | `{status, stage, error, octave_shift, autotune, timings}`; 404 si el servicio se reinició |
| `GET /jobs/{id}/audio` | — | MP3 mezclado |

Pipeline de `/convert`: ffmpeg → Demucs (voz/instrumental) → F0 de referencia y
canción (RMVPE con `clean_f0`) → decisión de octava → Seed-VC canto
(`f0_condition=True`, `auto_f0_adjust=False`, hook de autotune sobre la 2ª
llamada a RMVPE) → `mix()` (match_spectrum → match_envelope → add_reverb al
nivel medido con DeEcho → suma) → MP3 192k. Log útil: líneas `[voice] ref …`
y `[voice] mix glue: reverb …`.

Los módulos de Seed-VC, Apollo y los modelos UVR viven en `engine/voice/` y
`engine/voice/.cache/uvr` (ignorados por git). Parches conocidos en
`server.py`: `convert_voice` es un generador (resultado en `StopIteration.value`)
y el F0 de RMVPE se castea a float32 para MPS.

## Motor ACE-Step (:8001) — cuidado con los nombres

`POST /release_task` **crea** una generación (no la libera ni la consulta) y
`POST /query_result {task_id_list}` es el que consulta. No hay endpoint de
cancelación: una tarea encolada por error ocupa la GPU hasta terminar. Los
audios quedan en `engine/ACE-Step-1.5/.cache/acestep/tmp/api_audio/<uuid>.mp3`
(sirve para recuperar una variante si la web la descargó mal).
