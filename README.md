# Suno Local

App tipo Suno para crear canciones completas (letra + voz + instrumental) con **modelos que corren
en tu máquina**. No usa ninguna API externa.

- **Motor de audio**: [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) (MIT). Modelo DiT
  `acestep-v15-turbo` (2B) + LM `acestep-5Hz-lm-0.6B`, acelerado con MLX en Apple Silicon.
- **Letras** (modo simple): [Ollama](https://ollama.com) con el modelo que tengas instalado
  (`OLLAMA_MODEL`), con fallback al LM de ACE-Step.
- **Cantar con mi voz**: servicio en `engine/voice/` que separa la voz con
  [Demucs](https://github.com/facebookresearch/demucs) y la convierte a tu timbre con
  [Seed-VC](https://github.com/Plachtaa/seed-vc) (zero-shot, referencia de 10–30 s hablando, sin
  cantar ni entrenar). Puerto 8002.
- **Post-producción bajo demanda** (por pista, desde su tarjeta; nunca automática):
  - *Realce IA*: [Apollo](https://github.com/JusperLee/Apollo), modelo de restauración musical
    (band-split) que recupera detalle y reduce artefactos tipo códec de la salida del modelo.
  - *Masterización*: cadena ffmpeg en dos pasadas (limpieza de graves, reducción de ruido suave,
    EQ de presencia y aire, de-esser, compresión, loudness a -14 LUFS, limitador true-peak).
    Presets Claro / Cálido / Fuerte / Sin procesar.
  Siempre se parte del audio crudo del modelo, así que cualquier combinación es reversible.
- **Artistas y álbumes**: cada artista es una persona (o proyecto) con nombre, estilo por defecto,
  descripción, idioma y, opcionalmente, una o varias voces grabadas. Sus canciones se agrupan en
  álbumes. Al crear con un artista seleccionado se precargan su estilo y su voz; la voz es opcional
  en cada canción. Las canciones se pueden mover entre artistas y álbumes desde su tarjeta.
- **Editar con un prompt**: en cada canción terminada, una instrucción en lenguaje natural
  ("más batería", "el coro más épico", "más lenta y acústica") se traduce con Ollama a una
  operación de ACE-Step: *cover* (regenera toda la canción conservando melodía y estructura, con
  un control de fidelidad) o *repaint* (regenera solo un tramo, marcable desde el reproductor).
  El plan se muestra y se puede ajustar antes de aplicarlo. El resultado es una versión nueva
  enlazada a la original; si la original usaba una voz, la nueva se convierte sola.
- **Mercado**: entrada "📈 Mercado" en la barra lateral. Baja el top 100 del país (Apple Music RSS,
  sin API key) y lo enriquece con los géneros por álbum, duración y fecha de lanzamiento de Deezer
  (API pública). Muestra reparto de géneros ponderado por posición, % de lanzamientos recientes,
  top 20 y artistas dominantes. Con Ollama produce un análisis (tendencias dominantes / en
  crecimiento / nicho / saturado, huecos) y 6 ideas de canción adaptadas al perfil del artista,
  cada una con estilo listo para generar y un botón "Crear con esta idea". También admite
  preguntas libres sobre los datos. Es la única parte que necesita internet.
- **App web**: Next.js 16 + Tailwind + SQLite (better-sqlite3 + drizzle). Biblioteca, reproductor,
  descarga, 2 variantes por creación, panel "Mi voz" con grabación desde el micrófono.

```
Suno/
├── engine/            # ACE-Step 1.5 (clonado por `make setup-engine`, ignorado por git)
│   ├── .env           # modelo, LM, backend, puerto
│   ├── run.sh         # lanza la REST API en :8001
│   └── voice/         # servicio de conversión de voz (:8002)
│       ├── server.py  # FastAPI: Demucs + Seed-VC + mezcla
│       ├── run.sh
│       └── seed-vc/   # clonado por `make setup-voice`, ignorado por git
└── web/               # Next.js
    ├── src/app/api    # /artists, /albums, /songs, /songs/[id]/{audio,master,edit}, /voices, /lyrics, /engine
    ├── src/lib        # acestep.ts, voice.ts (clientes), ollama.ts, songs.ts, voices.ts, artists.ts, master.ts, market.ts, market-ideas.ts
    └── data/          # suno.db + audio/ + voices/ (ignorado por git)
```

## Requisitos

- macOS Apple Silicon (probado en M5 Pro, 24 GB) o Linux/Windows con GPU NVIDIA.
- `uv`, `pnpm`, `node ≥ 20`, `ffmpeg`. Opcional: `ollama`.

## Arranque

```bash
make setup    # clona ACE-Step y Seed-VC, crea los entornos Python, pnpm install, copia .env
make dev      # motor (:8001) + voz (:8002) + web (:3000)
```

La primera vez el motor descarga ~6 GB de pesos a `engine/ACE-Step-1.5/checkpoints/`.
Abre http://localhost:3000.

## Cómo funciona

1. La web recibe la petición (`POST /api/songs`). En modo **simple**, Ollama escribe título, tags de
   estilo y letra a partir de la descripción; en modo **personalizado** se usan los que escribes.
2. Se envía a ACE-Step (`POST /release_task`, `batch_size=2`). Se guardan 2 filas en SQLite con
   el mismo `task_id`.
3. La UI hace polling a `GET /api/songs`; el servidor consulta `POST /query_result`, y cuando el
   audio está listo lo descarga a `web/data/audio/<id>.mp3` y marca la canción como `done`.
4. `GET /api/songs/[id]/audio` sirve el archivo con soporte de `Range` para el reproductor.

### Post-producción

Cada canción se guarda dos veces: `<id>.raw.mp3` (salida cruda del modelo) y `<id>.mp3` (lo que se
reproduce; al crear es una copia del crudo). `POST /api/songs/[id]/master` con `{enhance, preset}`
reprocesa desde el crudo: opcionalmente `POST :8002/enhance` (Apollo) y luego la cadena ffmpeg. `?raw`
en la ruta de audio descarga la versión sin procesar. Con la voz convertida ocurre lo mismo
(`<id>.voice.raw.mp3` → `<id>.voice.mp3`). Los presets viven en `web/src/lib/master.ts`.

### Calidad del modelo

Lo que más cambia el sonido "sintético" es el modelo, no la post-producción. Con
`ACESTEP_ON_DEMAND_MODEL_LOAD=true` (ya en `engine/.env`) el selector de modelo de la app puede pedir
`acestep-v15-xl-turbo` (4B): se descarga (~9 GB) y se carga al vuelo la primera vez. Otras palancas:
más `inference_steps` en el modelo SFT y el VAE alternativo `scragvae` (`ACESTEP_VAE_CHECKPOINT`).

### Editar con un prompt

`POST /api/songs/[id]/edit` con `{instruction, start?, end?}` devuelve un plan
(`op`, `style`, `lyrics`, `strength`, `start`, `end`, `summary`) generado por Ollama; el mismo
endpoint con `{instruction, plan}` lo ejecuta subiendo el audio crudo de la canción a ACE-Step como
`src_audio` (`task_type=cover|repaint`, `audio_cover_strength`, `repainting_start/end`,
`chunk_mask_mode=explicit`). La nueva fila guarda `parentId`, `editOp` y `editInstruction`, y sigue
el mismo pipeline de sincronización que una canción normal. Sin Ollama, el plan se construye
directamente: cover con la instrucción añadida al estilo, o repaint si se marcó tramo.

### Mercado

`GET /api/market?country=co[&refresh=1]` devuelve la fotografía (cache de 12 h en la tabla
`kv_cache`). Fuentes: `rss.applemarketingtools.com` (top 100 por país con géneros gruesos) y
`api.deezer.com` (chart localizado por IP + `/album/{id}` para géneros + `/search` para casar cada
canción de Apple con su álbum en Deezer). `POST /api/market/ideas {country, artistId?, refresh?}`
y `POST /api/market/ask {country, artistId?, question}` pasan la fotografía resumida a Ollama. El
análisis tarda 3–5 min con el modelo de 12B y se cachea por fotografía + perfil.

### Cantar con mi voz

1. En la pestaña **Mi voz** grabas 10–30 s hablando (o subes un archivo). El micrófono se captura en
   crudo (sin cancelación de eco, supresión de ruido ni AGC del navegador: esos filtros dejan la voz
   hueca y el modelo aprende ese timbre). Se normaliza a WAV mono 44.1 kHz en `web/data/voices/` y se
   mide su tono con `POST :8002/analyze` (pYIN): mediana de F0,
   registro (bajo, barítono, tenor, contralto, mezzo, soprano) y rango cómodo de canto
   (0.8×–2.4× la mediana hablada). El registro se puede corregir a mano en la tarjeta de la voz.
2. Al crear con «Cantar con mi voz» activado, el estilo se reescribe para esa voz
   (`web/src/lib/voice-register.ts` → `voicePromptTags`): quita tags de voz contradictorios y añade
   registro, rango y timbre, p. ej. `male vocal, warm baritone voice, low-mid vocal register…,
   vocal range F2–C4, dark warm vocal timbre, clean vocals`, para que el modelo componga la
   melodía donde vive la voz y con un timbre parecido (menos distancia para la conversión). En
   modo simple Ollama recibe el mismo resumen (`voiceBrief`) para elegir género, tempo y melodía.
   El panel de crear muestra exactamente qué se añade. La canción se genera normal y pasa al estado `converting`: la web sube el MP3 y la
   referencia a `POST :8002/convert`.
3. El servicio separa voz/instrumental (Demucs htdemucs), compara el F0 de la voz de la canción con
   el de la referencia y, si la melodía queda muy por encima del rango cómodo, la baja una octava
   (misma tonalidad). Después convierte la voz con el modelo de canto de Seed-VC (`f0_condition`,
   sin `auto_f0_adjust` para no cambiar la tonalidad; el F0 se filtra para quitar saltos de octava
   de un solo frame que hacían "romper" la voz) y mezcla.

   Además del tono, `/analyze` devuelve `metrics` de timbre (centroide espectral, planitud, energía
   grave/media, amplitud de entonación, salto de tono entre frames, variación de volumen). La web
   (`voice-register.ts`) las convierte en rasgos legibles ("oscura", "limpia", "con mucho cuerpo"…),
   en un **tag de rango** (`baritone, vocal range F2–C4`, copiable y añadido al prompt) y en un
   ranking de géneros con motivos (reglas por registro + rasgos, sin LLM). Cada género tiene un
   botón «Crear» que precarga estilo y descripción en el panel de creación. Las ideas y preguntas
   de **Mercado** reciben el mismo resumen de la voz (`artistVoiceBrief`) para proponer solo lo que
   cabe en su rango y timbre. `POST /api/voices/[id]/analyze`
   vuelve a medir; el JSON completo se guarda en `voices.profile`.

   **Retocar grabación** (opcional, por voz): `POST :8002/clean-reference` = Demucs (solo la voz, fuera
   ruido/zumbidos) → UVR DeEcho-DeReverb (fuera sala/eco; `audio-separator`, modelo en
   `engine/voice/.cache/uvr`) → cadena ffmpeg de voz (HPF 80 Hz, afftdn, de-esser, EQ, compresor,
   loudnorm -18 LUFS; la reducción de ruido y un realce de presencia se activan solo si la toma es
   ruidosa o apagada). Se guarda como `<id>.clean.wav`, el original se conserva y una casilla decide
   cuál se usa; el perfil de tono se vuelve a medir sobre la activa.

   **Afinar la voz (autotune)** (opcional, por canción, al crear o después con «Reconvertir voz»):
   Seed-VC sigue la curva de F0 que se le da, así que antes de condicionar se lleva cada frame a la
   nota más cercana de la escala de la canción (`key_scale` de ACE-Step; cromática si no hay), con
   la nota decidida sobre una mediana de 70 ms y la corrección suavizada en 50 ms (vibrato y glides
   no parpadean). `POST /api/songs/[id]/voice {autotune}` reconvierte siempre desde `<id>.raw.mp3`.

   El servicio ejecuta un solo pipeline pesado a la vez (`_gpu_lock`: conversión, retoque o Apollo);
   correr Demucs + DeEcho + Seed-VC en paralelo sobre MPS mató el proceso sin traza.

   **Voz cantada sintética** («Usar como voz» en la tarjeta de una canción): `POST :8002/extract-reference`
   toma la salida del modelo (`<id>.raw.mp3`), separa la voz con Demucs, elige la ventana de 30 s con
   más canto y la guarda como voz `kind = singing` del artista (y como su voz por defecto). Es una
   referencia *cantada*, así que Seed-VC no tiene que imaginar cómo canta una voz hablada, y todas
   las canciones del artista salen con la misma voz. Para estas voces el rango es el medido
   (p10–p90 ± un tono), los tags de registro no limitan la melodía, y la octava solo se mueve si la
   canción está a una octava entera de donde canta la referencia (mediana contra mediana).
   «Voz y afinado» en la tarjeta permite reconvertir cualquier canción con otra voz.

   > Por qué: una grabación hablada cubre ~1 octava (p. ej. 77–138 Hz). Si la canción canta a
   > 200–330 Hz, Seed-VC tiene que inventar el timbre una octava por encima de lo que oyó y se
   > escucha raro justo en los agudos. Las tres capas atacan eso: componer en el registro, bajar
   > la octava cuando hace falta y limpiar el F0.
   La mezcla final «pega» la voz convertida al espacio de la original (`mix()` en `server.py`): EQ
   igualada al espectro de largo plazo del stem original (1/3 de octava, ±8 dB), envolvente de
   volumen igualada a la del stem (120 ms; recupera dinámica, fades y silencios), y una
   reverberación sintética al nivel wet/dry medido en el stem original con DeEcho (−24…−8 dB).
   Sin esto la voz de Seed-VC sale seca y plana y suena pegada encima del instrumental.
4. El resultado sustituye al audio de la canción; la versión original queda disponible con
   `?original` y en el botón «orig.» de la tarjeta. Si la conversión falla, la canción se conserva
   con la voz original y se muestra el error.

## Que suene como un video de YouTube (referencia)

En el panel de crear, «🎧 Que suene como un video de YouTube» acepta la URL de un video, lo analiza y
escribe el prompt de estilo a partir de lo medido (no de lo que dice el título). `POST /api/reference
{url, artistId?, refresh?, token?}` → `{analysis, prompt, cached}`; `GET /api/reference?token=` da la
etapa en curso. El análisis se cachea 30 días por video en `kv_cache` (`reference:youtube:<id>`).

1. `POST :8002/reference-analysis` (`engine/voice/reference.py`, bajo el `_gpu_lock`): **yt-dlp**
   baja la pista de audio (máx. 10 min) y los metadatos; **librosa** mide tempo (mediana del tempo
   por frame + alternativas mitad/doble), tonalidad (perfiles de Krumhansl sobre chroma CQT), sonoridad,
   rango dinámico, brillo, ataques/s, reparto espectral, curva de energía y un mapa de secciones
   (segmentación aglomerativa sobre chroma+MFCC, etiquetadas intro/peak/section/outro por nivel);
   **Demucs** separa batería/bajo/resto/voz → peso de cada stem, presencia y actividad de la voz,
   registro cantado (pYIN sobre los 30 s más cantados); **CLAP** (`laion/larger_clap_music_and_speech`,
   zero-shot sobre 6 ventanas de 10 s) puntúa géneros, moods, instrumentos (sobre la mezcla sin voz),
   estilo vocal (sobre el stem de voz) y producción; **faster-whisper** small detecta el idioma y
   transcribe un fragmento. Tarda 1–3 min (Demucs es la mitad).
2. La web (`web/src/lib/reference.ts`) construye unos tags deterministas a partir de las medidas
   (`buildReferenceTags`) y, si Ollama está en línea, le pasa el análisis completo para que escriba
   `style` (12–20 tags), `caption` (párrafo en inglés al estilo de la guía de ACE-Step), `summary` y
   `structure` (en español). El tempo y la tonalidad medidos se reimponen sobre lo que devuelva el
   modelo (`ensureMeta`). Si el artista tiene voz por defecto, el prompt describe **esa** voz, no la
   de la referencia. Nunca se mete el nombre del artista o el título: el modelo no imita artistas.
3. «Usar como estilo» rellena el estilo (modo personalizado); «Añadir a la descripción» pega el caption
   y la estructura a la descripción (modo simple, Ollama escribe letra y estilo con eso). En ambos casos
   los `bpm` y `keyScale` medidos van a `POST /api/songs` y de ahí al motor como metadatos fijos, en
   vez de dejar que su LM los adivine.

Límites conocidos: el género vocal por tono se equivoca con voces masculinas muy agudas (se combina
con CLAP); los instrumentos en zero-shot son la etiqueta más parecida del vocabulario (`INSTRUMENTS`
en `reference.py`), no una detección; los videos de más de 10 min se rechazan.

## Imagen del artista y portada del álbum (OpenAI)

Única pieza que sale del Mac, y solo cuando el usuario pulsa el botón: `web/src/lib/openai-images.ts`
llama a `POST https://api.openai.com/v1/images/generations` con `gpt-image-2` («ChatGPT Imágenes 2.0»; clave en
`OPENAI_API_KEY`, en el entorno de `pnpm dev` o en `web/.env.local`; `OPENAI_IMAGE_MODEL` para
cambiar el modelo). 1024×1024, calidad baja/media/alta ≈ 0,01 / 0,04 / 0,17 USD, ~20 s.

- Artista: sección «Imagen de …» en el perfil. `GET /api/artists/[id]/image?suggest` propone un
  prompt a partir de nombre, descripción y estilo (o devuelve el último usado); `POST` con
  `{prompt, quality}` genera y guarda `data/images/artists/<id>.<ts>.png`; `GET` la sirve. Se ve en
  el rail, en la cabecera de la biblioteca y como portada de las canciones sin álbum.
- Álbum: botón 🖼 junto al chip del álbum seleccionado abre el mismo editor; el prompt sugerido
  incluye los títulos de sus canciones. `/api/albums/[id]/image` igual que el de artistas. La
  portada del álbum manda sobre la del artista en las tarjetas.

## Video de imágenes (🎬 en la tarjeta)

Servicio aparte en `engine/video/stills/` (`make video`, :8003, mismo venv que el PoC de video
`engine/video/.venv`). Para una canción terminada:

1. `POST /api/songs/[id]/video {provider, subtitles}` → `buildStoryboard` (`web/src/lib/storyboard.ts`):
   Ollama escribe el **estilo visual** del clip deducido del género y la personalidad del artista
   (fotografía con grano, ilustración, 2D, 3D, collage…; no hay estilo fijo), el personaje (una frase
   que se repite en todas las escenas) y una escena por sección de la letra (prompts en inglés,
   planos cerrados). `layoutTimeline` reparte la duración por líneas, parte las secciones largas en
   dos ángulos y corta al compás (`240/bpm`).
2. Imágenes, según `provider`:
   - `openai` (por defecto si hay clave): `renderScenesWithOpenAI` en `songs.ts` genera cada escena
     con gpt-image-2 a 1536×1024 (~0,06 USD, ~20 s) pasando como referencia el retrato del artista o
     la primera escena (`/v1/images/edits`, que es lo que mantiene al personaje). Corre desacoplado
     de la petición; el progreso va a `videoProgress`. Las escenas quedan en
     `web/data/video-scenes/<songId>/` y se suben a `POST :8003/videos` como `images`, que entonces
     solo monta.
   - `local`: `POST :8003/videos` (audio + storyboard + retrato opcional en
     `web/data/portraits/<artistId>.png`): Wan 2.1 VACE 1.3B con `num_frames=1`; la primera imagen
     (o el retrato) va como `reference_images` a las demás. Medido en M5 Pro: 32 s la primera, ~65 s
     cada una con referencia (135 s con el Mac en swap), 832×480 @ 25 pasos, pico 15.5 GB MPS.
   Después ffmpeg monta Ken Burns (zoom/paneo alternos) + `xfade` en los cortes + audio → MP4
   1280×720 24 fps (`slideshow.py`, ~2 s por minuto de video).
3. La web sondea `GET :8003/videos/{id}` en cada `GET /api/songs` y guarda `<id>.video.mp4`;
   `GET /api/songs/[id]/video` lo sirve con `Range` para el `<video>` de la tarjeta.

**Letra en pantalla** (casilla «con letra», por defecto activa en canciones con voz): antes de
enviar el trabajo, `POST :8002/align-lyrics` (servicio de voz) separa la voz con Demucs, la
transcribe con faster-whisper `medium` (CPU int8, ~50 s por canción, la letra como `initial_prompt`)
y alinea las palabras oídas con la letra conocida (difflib sobre tokens normalizados; solo anclan
rachas de ≥ 2 palabras, se descartan anclas no monótonas, el resto se interpola y cada línea se
acota a ~0,9 s por palabra). El resultado va en `storyboard.lyrics`; `stills/subtitles.py` lo
convierte en un `.ass` con relleno karaoke por palabra (`\kf`), Avenir Next, borde y sombra,
fundidos de 200 ms, y `slideshow.py` lo quema con el ffmpeg de imageio-ffmpeg (el de Homebrew no
trae libass). Se omite si la confianza de alineación baja de 0,25.

Memoria: el servicio espera a tener `STILLS_MIN_FREE_GB` (6) disponibles antes de cargar modelos y
lo dice en la etapa. En la práctica: con motor + voz + Ollama residentes se arrastra; `ollama stop
<modelo>` y apagar motor o voz mientras renderiza. Un solo trabajo pesado a la vez (`_gpu_lock`),
la pipeline se libera al terminar, y las imágenes ya renderizadas se reutilizan si el trabajo se
relanza en el mismo directorio.

## Cambiar de modelo

Edita `engine/.env`:

| Variable | Valores |
|---|---|
| `ACESTEP_CONFIG_PATH` | `acestep-v15-turbo` (rápido, recomendado), `acestep-v15-sft`, `acestep-v15-xl-turbo` (4B, ~9 GB) |
| `ACESTEP_LM_MODEL_PATH` | `acestep-5Hz-lm-0.6B`, `-1.7B`, `-4B` |
| `ACESTEP_LM_BACKEND` | `mlx` (Mac), `pt`, `vllm` (CUDA) |

Rendimiento medido en M5 Pro: ~45 s para 2 variantes de 30 s.
