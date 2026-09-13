---
name: suno-music-studio
description: "Operar Suno Local (~/www/personal/Suno): crear artistas y canciones, mantener su identidad vocal con una referencia fija y selección por parecido, y diagnosticar conversiones de voz. Usar al pedir canciones de un artista, voz sintética consistente, usar una voz propia o corregir voces con gallos o textura artificial."
---

# Suno Local: crear artistas, canciones y voces que suenen bien

Tres procesos locales, todos en el Mac, ninguno en la nube:

| Servicio | Puerto | Qué es | Arranque |
|---|---|---|---|
| Motor ACE-Step 1.5 | :8001 | genera la canción completa (voz + instrumental) | `make engine` |
| Servicio de voz | :8002 | Demucs + Seed-VC + DeEcho + Apollo (`engine/voice/server.py`) | `make voice` |
| Web Next.js | :3000 | UI + API + SQLite (`web/data/suno.db`) | `make web` |

`make dev` levanta los tres. `make check` = typecheck + lint de la web. Python del
servicio de voz: `engine/voice/.venv/bin/python` (py3.10, uv). Ollama local
(`gemma4-coder`) escribe letras y estilos en modo simple.

**Antes de cualquier cosa**: `curl :8001/health`, `curl :8002/health`,
`curl :3000/api/engine`. Si `:8002` responde vacío o `000`, el proceso murió
(ver "Cosas que tumban el servicio").

La referencia de endpoints y cuerpos está en [api.md](api.md). Las mediciones y
scripts que sirvieron para diagnosticar están en [diagnostico.md](diagnostico.md).

## Modelo mental que ordena todo

1. **El artista guarda la referencia, no garantiza el cantante.** `artistId` agrupa las
   canciones; `defaultVoiceId` fija la referencia. Los tags orientan registro y timbre,
   pero una generación puede sonar a otra cantante. Mantener la identidad exige comparar
   cada toma con la misma referencia y con las canciones aceptadas del artista.
2. **Preferencia del usuario: naturalidad con identidad vocal consistente.** Crear sin
   conversión por defecto; elegir tomas parecidas sin re-sintetizarlas. Seed-VC queda para
   solicitudes explícitas de conversión. El híbrido tampoco garantiza calidad: el usuario
   rechazó «Cien Veces» y «Sin Aire» de Tokio por gallos; en «Cien Veces» estaban apagados
   autotune y cambio de octava. No resolver una petición de consistencia activando conversión.
3. **Referencia fija y entrenamiento son mecanismos distintos.** Una referencia `singing`
   contiene canto; una `speech` contiene habla y su puntuación no se interpreta con los
   umbrales de canto. Un LoRA puede orientar la generación hacia la identidad del artista,
   pero requiere material coherente y validación audible: tampoco garantiza identidad.
4. **Todo procesado es opt-in y reversible**: masterización, Apollo, retoque, esculpido,
   conversión y autotune. Conservar `<id>.raw.mp3` y respaldar antes de reemplazar resultados.

## Flujos

### Crear un artista y su primera canción

1. `POST /api/artists` con `name`, `emoji`, `style` (tags en inglés, **incluye el
   género vocal**: `powerful female vocals` / `warm male vocals`), `description`
   (en español: quién es, temas, cómo suena la voz; guía las letras) y
   `vocalLanguage`.
2. **Pedir la letra antes de tocar el motor**: `POST /api/lyrics {description,
   language, instrumental: false, voiceId: <defaultVoiceId del artista>}` devuelve
   `{draft: {title, style, lyrics}}` sin encolar nada. `description` en español con el
   tema y el arco emocional; `voiceId` solo informa al escritor del registro y rango
   de esa voz (no convierte). Revisar y corregir aquí sale gratis.
3. **Revisar el borrador línea por línea. ACE-Step canta todo lo que no sea una
   etiqueta `[Sección]`**, así que una acotación se convierte en verso cantado:
   - **Acotaciones y descripciones de producción**: fuera todas. Casos reales de
     septiembre 2026: `[Intro]` seguido de "Guitarras limpias y tensas", y en el resto
     de la letra "(Casi hablado)", "(Rabia creciente)", "(Explosivo y gritado)",
     "(Fade out con distorsión)". El `SYSTEM` de `draftSong` ya dice "sin comentarios"
     y `cleanLyrics` no las detecta: la revisión es la única defensa.
   - **Paréntesis**: solo valen si son coros que se cantan ("(no me muero)"),
     nunca instrucciones para el productor.
   - **Palabras inventadas o coladas de otro idioma**: "Thesa se acopla al ritmo",
     "The peso del colchón", "Themede", "broda". Gemma las mete aunque el prompt
     nombre el idioma y prohíba mezclar.
   - Idioma correcto en toda la letra, `female/male vocals` correcto en el estilo,
     sin `\n` literales.
   - El `[Intro]` es el sitio donde más aparecen: si no hay nada que cantar, dejarlo
     vacío o poner una frase corta del estribillo, nunca una descripción del arreglo.
   - **Cantabilidad**: aplicar «Escribir letras cantables, no crónicas» (más abajo). Una
     letra correcta pero narrada tampoco pasa.
4. Crear con `POST /api/songs` modo `custom` pasando el `title`/`style`/`lyrics` ya
   corregidos, más `artistId`, `master: "off"` y los campos de identidad vocal del flujo
   siguiente. El estilo se completa igualmente con la voz del artista (registro, rango,
   timbre) o, si no tiene voz, con el género vocal declarado en su `style`. Eso **no basta**
   si el género musical tiene prior masculino (nu metal, metal, rap, punk) o si el estilo lleva
   tags de interpretación colectiva (`gang vocals`, `chanted crowd chorus`, `shouted chorus`):
   ver «Cuando sale voz de hombre aunque el estilo pida mujer» antes de escribir el estilo.
   **Duración**: no fijar la misma para todas las canciones de un artista. El usuario (11 sept
   2026) rechazó tres canciones de Valentín todas de 3:30 por copiar el ADN de una anterior:
   quiere que varíe «automático entre 2:30 y 3:30». Con `duration: null` el motor la elige pero
   no respeta ese rango (ha dado 2:38 y 3:43), así que sortear un valor entre 150 y 210 s
   (múltiplo de 5) por canción y mandarlo en `duration`; las variantes de un lote comparten
   duración. Solo fijar una duración concreta si el usuario la pide.
   **No usar el modo `simple` para producir**: escribe la letra dentro de la misma
   llamada que encola la generación, así que una letra mala ya viene con el lote de
   variantes pagado, y **borrar las filas no cancela la tarea del motor** (quedan
   huérfanas y ocupan ~4 min de GPU cada una). En septiembre 2026 eso dejó cuatro tomas
   de Tokio cantando "Guitarras limpias y tensas" y ~10 min de GPU tirados.
5. Seguir el progreso con `GET /api/songs?artist=<id>` (ese GET es el que
   sincroniza con el motor y el servicio de voz; sin pollearlo no avanza nada).
   Una creación de 3 min con 2 variantes tarda 3–5 min; con Ollama compitiendo
   por la memoria puede tardar el doble.
6. Mandar los MP3 al usuario (`web/data/audio/<id>.mp3`; con voz convertida,
   `<id>.voice.mp3`, y el original queda en `<id>.mp3` con `?original`).

### Escribir letras cantables, no crónicas

Veredicto del usuario (9 sept 2026, tres canciones de Sebas Marea escritas a mano por el
agente): «están muy narradas, poco cantables». Las tres contaban la historia del brief
en orden, con versos de 14–18 sílabas, fechas, diálogos entre comillas y sin rima fija.
Escribir bien la letra es la parte de la canción que más pesa y la única que no cuesta GPU.
Tanto el borrador de Ollama como una letra escrita por el agente pasan por estas reglas:

- **El brief es el argumento, no la letra.** El usuario cuenta la historia completa
  («instagramea, la encuentra, se enamora, la ve en una farra, bailan toda la noche»);
  la canción escoge **un momento y una emoción** y la repite. La cronología se sugiere
  con dos imágenes, no se narra estrofa por estrofa. Prohibidos los conectores de
  crónica: «lunes», «el miércoles», «dos años después», «ayer volví», «y luego».
- **Frases cortas.** Verso: 6–10 sílabas por línea, máximo 8 palabras. Estribillo: líneas
  de ≤ 8 sílabas. Prueba: leer la línea en voz alta marcando cuatro pulsos; si necesita
  más de una respiración, se corta en dos o se tira. Un verso de más de 50 palabras es
  crónica, no canción.
- **Rima siempre, en pareados (AABB) o alternada (ABAB)**, consonante o asonante fuerte
  y en todas las líneas del estribillo. Líneas sueltas sin rima suenan a texto leído.
- **Estribillo = gancho repetido.** Cuatro líneas como máximo, el título dentro y
  repetido al menos dos veces, y la última línea puede ser la primera. En urbano/pop
  añade un gancho vocal cantable («eh-eh», «oh-oh-oh», «mor», «mami», «yeh»); ACE-Step
  los canta bien y son lo que hace la canción memorable.
- **Presente y segunda persona.** «Te veo», «bailas», «me miras». Nada de «me dijiste
  que…» ni diálogos entre comillas: se cantan fatal y suenan a cuento.
- **Una imagen concreta por línea, el resto es sensación.** Máximo dos datos concretos por
  verso (un lugar, un objeto); lo demás es lo que siente. Sin explicar lo que ya dice
  la imagen.
- **Estructura que respira.** Verso ≤ 8 líneas, pre-coro de 2 líneas que sube con
  repetición, bridge de 4 líneas con una frase repetida, drop/outro con 2–3 líneas del
  gancho. Los versos 1 y 2 pueden compartir la mitad de sus líneas.
- **Registro del artista, no del narrador.** Jerga y fraseo del género del artista (para
  reguetón paisa: Feid, Ryan Castro, Blessd → frases cortas, «mor», «parce», «bebé»,
  ad-libs); para balada, imágenes y menos jerga. La `description` del artista lo dice.

Antes y después, misma idea (encontrarla en Instagram):

```
❌ Le di like a todo, hasta a la del dos mil veinte,
   Me vi tus historias como quince veces seguidas.
   Me enamoré de ti sin haberte conocido,
   Y no me atreví a escribirte ni un "hola, ¿cómo has estado?".

✅ Te vi en una story, mor,
   y me quedé sin señal.
   Un like que se me escapó,
   y otro que no fue casual.
```

Dónde vive cada regla: las **generales** (líneas cortas, rima, gancho, sin cronología ni
acotaciones) están en esta sección y en el `SYSTEM` de `draftSong` (`web/src/lib/ollama.ts`),
así que el borrador de la web ya las recibe. La **forma de escribir de cada artista**
(jerga, muletillas, sílabas por línea, post-coro habitual, referencias de tono) va en la
`description` del artista, en un párrafo «Cómo escribe sus letras: …»: la web la concatena
al pedir el borrador y el agente la lee antes de escribir. Sebas Marea ya lo tiene (10 sept
2026); al crear un artista nuevo, escribir ese párrafo desde el principio. Aun con todo eso,
reescribir lo que no cumpla las reglas. Si el agente escribe la letra sin Ollama, pasar el mismo
filtro y contar sílabas en el estribillo antes de encolar: cuatro variantes son ~15 min
de GPU, y una letra narrada no la arregla ninguna toma.

### Mantener la voz del artista en cada canción

1. Consultar el artista y sus voces antes de crear. Resolver `defaultVoiceId`, verificar
   que pertenece al artista y conservar esa referencia entre canciones. No elegir otra voz,
   retocarla, esculpirla ni cambiar el default para hacer que una toma distinta pase el filtro.
   Si falta la referencia, revisar las canciones aceptadas y acordar cuál define su voz.
   Para un artista nuevo, elegir primero una toma y usar `POST /api/voices/from-song {songId}`:
   extrae canto del crudo y **cambia la voz por defecto**. No repetirlo en cada creación.
2. Crear con el perfil de esa voz y el estilo del artista, en modo `custom` y con la
   letra ya revisada (paso 2–3 del flujo anterior). En `POST /api/songs`, pasar
   explícitamente `artistId`, `voiceMatchId: defaultVoiceId`, `voiceId: null`,
   `voiceOptions: null`, `autotune: false`, `master: "off"`. `artistId` por sí solo no
   aplica esos campos. `voiceMatchId` orienta registro/timbre y solicita la comparación;
   `voiceId` activa conversión y no se usa en este flujo. Elegir 4 candidatos si el usuario
   no fijó cantidad o presupuesto; respetar su límite. Ver ejemplo en [api.md](api.md).
3. Consultar `GET /api/artists/[id]/lora`. Si hay un LoRA del artista ya validado por oído,
   listo y disponible, enviar `useLora: true` y mantener `voiceMatchId` para comprobar el
   resultado. `status: done` solo confirma que terminó el entrenamiento. Sin LoRA validado,
   usar `useLora: false` y explicar que se seleccionan voces parecidas. No iniciar entrenamiento
   por una petición ordinaria de canción: ocupa el motor e impide generar durante ese tiempo.
4. Pollear `GET /api/songs?artist=<id>` hasta `done` y después hasta que cada candidato
   tenga `voiceSimilarity` para la referencia correcta: el score llega en polls posteriores.
   Si falta o falla, reportar la evaluación pendiente; nunca tratar `null` como aprobado.
   Para canciones existentes, pedir `POST /api/songs/[id]/voice-match {voiceId: defaultVoiceId}`.
5. Ordenar por parecido y comparar por escucha la referencia y las mejores tomas en verso,
   coro y agudos: identidad del timbre, acento, fraseo, gallos y textura artificial. El coseno
   CAMPPlus es una señal de selección, no una probabilidad ni prueba del mismo cantante;
   0,8 es una heurística local para referencias cantadas. Una puntuación alta no compensa
   una voz distinta o deteriorada. Si no hay escucha disponible, entregar candidatos con
   puntuación e indicar que la consistencia audible está pendiente de validación del usuario.
6. Si ninguna toma conserva la identidad y naturalidad, comunicarlo. No presentar la mejor
   de un lote malo como voz consistente, cambiar la referencia ni convertirla para forzarla.
   Hacer solo el lote autorizado; un nuevo lote o entrenamiento necesita estar dentro del
   alcance acordado. Conservar las tomas hasta que el usuario decida cuáles descartar.

Para Tokio, la referencia actual procede de «Cenizas y Fuego»; consultar el default vigente,
no copiar UUIDs de conversaciones anteriores. Restaurar una canción al crudo elimina la
conversión, pero **no demuestra** que ese cantante coincida con Tokio: hay que medir y escuchar.

Para mayor consistencia, evaluar un LoRA con al menos tres canciones de identidad y calidad
aceptadas. Revisar el material antes de entrenar: el selector actual de `lib/lora.ts` admite
la canción origen y los crudos con score ≥ 0,8; ese filtro automático no sustituye la revisión
por oído. Nunca entrenar con conversiones rechazadas ni prometer que el entrenamiento fijará
exactamente el timbre. Después, validar canciones nuevas antes de adoptarlo para el artista.

### Cuando sale voz de hombre aunque el estilo pida mujer

`applyRegister` (`web/src/lib/voice-register.ts`) solo garantiza que los tags de voz estén y
que no haya contradicción, y **los añade al final** del estilo. La cabeza del prompt pesa más,
y hay dos cosas que arrastran el timbre al lado masculino:

1. **El género musical**: nu metal, metal, rap, punk, hardcore.
2. **Tags concretos de interpretación**, con cualquier género. `gang vocals` y
   `chanted crowd chorus` son, en el entrenamiento, coros de hombres gritando; también
   `shouted chorus`, `rap verses`, `screams`, `chants`.

Dos casos de septiembre 2026, ambos de Tokio (soprano, referencia fija) y ambos con
`powerful female vocals` ya en el estilo y `female vocal, soprano voice, …` añadido al final:
«Sangre de Taller» (nu metal) salió con cantante hombre en las cuatro tomas, y
«La Misma Mano» (rock alternativo, nada extremo) también, por culpa de
`chanted crowd chorus, gang vocals` con el género vocal en la posición 10 de 11 tags.

Qué hacer en un género de prior masculino o con tags de interpretación colectiva (o al revés,
con un artista hombre en géneros de prior femenino):

- **Abrir el estilo con el género vocal**, no dejarlo en medio ni confiar en lo que añade el
  código: `female-fronted nu metal, powerful female vocals, female singer, woman singing lead,
  downtuned guitar riffs, …`.
- **Usar el subgénero que ya existe como etiqueta**: `female-fronted nu metal`,
  `female-fronted metal`. Pesa más que repetir `female vocals` tres veces.
- **Todo tag que nombre una forma de cantar lleva el género pegado**: `female rap verses`,
  `female crowd chants in the chorus`, `women shouting along`. Nunca `gang vocals`,
  `chanted crowd chorus`, `aggressive rap-sung verses` ni `shouted chorus` a secas.
- **Leer el score como detector, no solo como ranking**: un `voiceSimilarity` claramente por
  debajo de la banda habitual del artista no es "una toma algo peor", es que canta otra
  persona. Tokio se mueve en 0,83–0,88; las tomas con voz de hombre dieron **0,54–0,62**
  («Sangre de Taller») y **0,63–0,73** («La Misma Mano»), y el usuario lo confirmó por oído en
  ambas. Con el estilo corregido volvió a 0,82. Ante ese salto, escuchar antes de entregar y
  rehacer el lote; no presentarlo como candidato ni justificar el número por el género musical.

### Cuando el tempo se va a los extremos y cambia el cantante

Si no se mandan `bpm`/`keyScale` en `POST /api/songs`, el LM del motor los elige en la fase
«Generating CoT metadata» y puede irse a cualquier parte: para Valentín Reyna (mariachi, referencia
extraída de una canción a 65 bpm en Mi menor) dos lotes de «Que No Cierre la Cantina» (10 sept 2026)
salieron a **200 bpm** y a **37 bpm**, con score 0,60–0,64 contra la voz (la canción origen da 0,89
y su variante hermana 0,83). Cambiar el estilo no lo arregló; fijar `bpm: 68, keyScale: "E minor"`
subió el lote a 0,66–0,76. Antes de rehacer un lote por voz distinta, mirar `bpm`/`key_scale` de
las tomas en `songs` y compararlos con la canción origen de la referencia; si se alejan, fijar los
metadatos en la llamada (como hace «Usar como estilo» de la referencia de YouTube). Aun así el
tempo no es todo: en ese caso el lote fijado quedó en el borde bajo de la banda histórica
(0,74–0,85) y pendiente de oído.

### Esculpir la voz para que sea única

Tarjeta de voz → «🎨 Esculpir voz» (`POST /api/voices/[id]/sculpt {formant, pitch,
brightness}` → `:8002/sculpt-reference`, Praat vía parselmouth, CPU, ~10 s). Formantes
en % (−20 grande/oscura, +20 pequeña/brillante) sin mover la nota, tono en semitonos,
aire en dB a 3 kHz. Se guarda `<id>.sculpt.wav`, casilla `useSculpt`, perfil re-medido;
`voicePath` prefiere esculpida > retocada > original. Las canciones hechas no cambian
hasta reconvertir. Valores que funcionaron como punto de partida: formant −8, pitch −1,
brightness +1.5 (voz un poco más grande y con aire). Rangos: ±30 %, ±12 st, ±12 dB; más
de ±15 % de formantes suena a efecto.

### Usar la voz de una persona

1. Grabar en la pestaña "Mi voz": captura **en crudo** (sin cancelación de eco ni
   supresión de ruido del navegador: dejan la voz hueca y el modelo aprende eso),
   a 10–20 cm del micro, 30 s completos. Con auriculares con micro mejor.
2. Se analiza sola (`/analyze`): registro, rango cómodo (0.8×–2.4× de la mediana
   hablada), rasgos de timbre, tag de rango, géneros recomendados con motivo.
3. "Retocar grabación" (`/clean-reference`) solo si hace falta: Demucs → DeEcho
   → cadena de voz adaptativa. Original conservado, casilla para alternar.
4. Al crear, seguir el flujo de referencia fija y selección anterior. Solo si el usuario
   pide conversión, el estilo recibe tags de registro + rango + timbre y la conversión
   puede bajar la melodía una octava si queda muy por encima; el mezclador
   integra la voz (EQ y envolvente del stem original, reverb medida).
5. Si la conversión sigue fallando, comparar original y resultado; no atribuirlo al rango
   sin medirlo. Una referencia hablada puede limitar el resultado. Siguientes pasos
   en orden de coste: referencia tarareada/cantada de 30 s → voz sintética →
   fine-tuning de Seed-VC (`train.py`, mínimo 1 frase, ~100 pasos) → RVC/Applio.

### Imagen del artista y portada del álbum

Perfil del artista → «Imagen de …» (o 🖼 en el chip del álbum): prompt sugerido editable →
`POST /api/artists/[id]/image {prompt, quality}` / `/api/albums/[id]/image`. Es la única
llamada externa de la plataforma (OpenAI `gpt-image-2` = «ChatGPT Imágenes 2.0», el usuario lo pidió expresamente; `OPENAI_IMAGE_MODEL` lo cambia; clave `OPENAI_API_KEY` en el entorno
de la web; `GET …/image?suggest` dice `configured`). Cuesta dinero: no regenerar en bucle
para "probar"; una imagen por prueba y que el usuario decida. Los prompts buenos describen
pelo, ropa, luz, encuadre y terminan en "no text, no logos, square format".

### Video de imágenes para una canción

Tarjeta → "Crear video" (`POST /api/songs/[id]/video {provider, subtitles}`). Servicio
`make video` (:8003, `engine/video/stills/`, venv `engine/video/.venv`). Ollama escribe el
**estilo visual del artista** (nada de Pixar fijo: el usuario lo rechazó), el personaje y una
escena por sección. Imágenes con `provider: "openai"` (por defecto: gpt-image-2, retrato del
artista como referencia vía `/images/edits`, ~0,06 USD y ~20 s por escena, ≈ 0,8 USD por
canción) o `"local"` (VACE 1.3B, 832×480, 32 s la primera, ~65 s con referencia, ~14 min por
canción y el Mac sin memoria). ffmpeg monta Ken Burns + cortes al compás → `<id>.video.mp4`. **Antes de
lanzar**: `ollama stop <modelo>` y apagar motor/voz si no hay canciones en curso (ver README
"Video de imágenes"); el servicio espera memoria y lo dice en `videoProgress`. Revisar el
storyboard que devuelve el POST: si Ollama dio menos escenas que secciones, el código
reintenta y rellena por sección, pero un storyboard con la misma frase repetida es señal de
que el modelo se cortó. Letra en pantalla (karaoke): la alinea `POST :8002/align-lyrics` (Demucs + faster-whisper
medium + difflib; ~50 s) y la quema `stills/subtitles.py` con el ffmpeg de imageio-ffmpeg
(el de Homebrew no tiene libass). Revisar `confidence` y que ninguna línea dure > 12 s; una
sola palabra suelta ancló mal un estribillo entero hasta exigir rachas de ≥ 2 palabras.
Para rehacer solo el montaje (letra, transiciones) sin re-renderizar 25 min de imágenes:
las escenas están en `engine/video/stills/.cache/jobs/<job>/scenes/`, y
`slideshow.build(imgs, durations, audio, out, subtitles=ass)` monta en ~20 s.
Retrato fijo del artista: `web/data/portraits/<artistId>.png` (se
usa como referencia si existe; `POST :8003/portrait` lo genera). No tocar `engine/video/poc`
ni `engine/video/cloud` (PoC de video animado de otro agente); `stills/` solo importa
`poc/common.py`.

### Que suene como un video de YouTube (referencia)

Panel de crear → «🎧 Que suene como un video de YouTube» → `POST /api/reference {url,
artistId?}` (1–3 min la primera vez, caché 30 días por video en `kv_cache`). El servicio
de voz (`engine/voice/reference.py`, `POST :8002/reference-analysis`) mide de verdad:
yt-dlp → librosa (bpm, tonalidad Krumhansl, dinámica, secciones) → Demucs (peso de stems,
voz, registro) → CLAP zero-shot (género/mood/producción en la mezcla, instrumentos por
stem, hombre/mujer en el stem de voz) → whisper small (idioma + fragmento). La web escribe
`style`/`caption`/`summary`/`structure` con Ollama partiendo de tags deterministas
(`buildReferenceTags`) y reimpone bpm, tonalidad y tags de voz (`ensureMeta`): gemma
los pierde una de cada tres veces. «Usar como estilo» rellena el estilo; los `bpm`/`keyScale`
medidos viajan a `POST /api/songs` y al motor como metadatos fijos. Con curl: pasa
`bpm`/`keyScale` a mano si quieres ese comportamiento. Gotchas: el género vocal por tono
falla con tenores agudos (Despacito → "female"); manda CLAP. Los instrumentos son "la
etiqueta más parecida" de un vocabulario cerrado (un cuatro sale como mandolin): el prompt
de Ollama lo sabe y traduce; para un instrumento nuevo, añádelo a `MELODIC/PERCUSSION/BASS`.

### Post-producción y edición

- `POST /api/songs/[id]/master {enhance, preset}`: Apollo + preset ffmpeg,
  siempre desde el crudo. Nunca por defecto: el usuario rechazó el mastering
  automático ("sigue sonando sintético").
- `POST /api/songs/[id]/edit`: Ollama planifica cover/repaint sobre el crudo sin
  voz; si la original tiene `voiceId`, la nueva fila lo hereda y se reconvierte sola.
  Para el flujo natural, partir de una versión sin conversión. La edición no hereda
  `voiceMatchId` ni aplica el LoRA en el flujo actual: volver a solicitar el score con la
  referencia fija al terminar y validar identidad, sin darla por conservada.
- Mercado (`/api/market/*`): ideas y preguntas reciben el `voiceBrief` de la voz
  por defecto del artista.

## Cosas que tumban el servicio o engañan (todas pasaron)

- **Un solo pipeline pesado en la GPU.** Demucs + DeEcho + Seed-VC en paralelo
  sobre MPS mató el proceso sin traza (`/health` → 000, web dice "fetch failed").
  Hay `_gpu_lock`; no lo quites. Al reiniciar, la web reenvía sola los jobs que
  el servicio olvidó (los jobs viven en memoria).
- **No reiniciar `:8002` con jobs corriendo** (`sqlite3 web/data/suno.db "select
  count(*) from songs where status='converting'"` → 0 antes de `pkill`). Arranque
  con `nohup engine/voice/run.sh > <log> &` y esperar `/health` ok; la primera
  conversión paga ~60 s de carga de modelos.
- **Memoria**: gemma 12B (~10 GB) + ACE-Step + servicio de voz en 24 GB → pageouts
  masivos, Ollama tarda >5 min. `memory_pressure` y `ps -eo rss` para confirmar.
- **`loudnorm` de ffmpeg saca 192 kHz** si no pones `-ar`; una medición espectral
  "perdió 30 dB de agudos" por eso. Medir siempre leyendo el sr real del archivo.
- **`deesser=i=0.4` quitó 9 dB de 3–7 kHz** de la referencia: la voz retocada
  quedó apagada y la conversión opaca. Ahora `i=0.12` + shelf de compensación.
  Cualquier cambio en la cadena se valida con `hi_mid_db` antes/después.
- **Octava con referencia cantada**: el tracker de tono pone p10 ≈ 88 Hz por
  coros/armonías y la regla de rango elegía −12 sin motivo. Para `singing` la
  regla es mediana contra mediana (solo mueve si hay una octava entera).
- **Parser JSON de Ollama**: comillas sin escapar, comentarios fuera del objeto,
  salidas cortadas. `parseLlmJson` repara; si falla, el modelo repara su propia
  salida a temperatura 0; la salida cruda va al log del server web.
- **La captura del navegador** con `echoCancellation/noiseSuppression/autoGainControl`
  en `true` tapa el ruido del micro pero deja la voz "bajo el agua". En crudo se
  ve el ruido real (−45 dB en un micro de portátil): el retoque lo trata.
- **Demucs sí sirve como denoiser de habla** (deja solo la voz) pero pierde ~2 dB
  de aire; DeEcho-DeReverb no hace nada si la toma ya es seca (stem "reverb" a
  −50 dB): sospechar del procesado, no de la sala.

## Cómo decidir con números y no con impresiones

Antes de "mejorar" la voz, medir (scripts en [diagnostico.md](diagnostico.md)):

- F0 de referencia vs F0 de la voz de la canción (mediana, p10, p90). Si la
  canción canta una octava por encima de la referencia hablada, el problema es
  de rango, no de modelo.
- Suelo de ruido, `hi/mid` (3–7 kHz vs 0.3–3 kHz), decaimiento a −20 dB y
  componente de reverb (stem de DeEcho) de cada grabación: dicen si la toma es
  ruidosa, apagada o con sala. Cris 2 "sonaba con eco" y en realidad tenía el
  doble de ruido y 9 dB menos de agudos por grabar lejos.
- Correlación de envolventes RMS entre stem original y voz convertida
  (0.95 → 0.997 con `match_envelope`): mide "integración".
- Tras cualquier cambio: una conversión real de una canción conocida, mandar el
  MP3 al usuario y **dejar que él diga** si mejoró. Los números descartan
  hipótesis; no sustituyen el oído del usuario.

### Cuando la conversión suena "metálica / sintética" (medido sept. 2026)

Caso de referencia: canción convertida con una voz cantada extraída de **esa misma
canción** (conversión casi identidad) y aun así peor que el crudo. Métricas sobre el
stem convertido vs el stem original (`scripts/measure_stems.py`, CPU, ver
[diagnostico.md](diagnostico.md)): Seed-VC saca **+6 dB en 3–7 kHz y 8–16 kHz, −2.7 dB
de HNR, presencia más ruidosa (planitud 0.25 vs 0.18)**, F0 clavado (corr 0.99) y
distancia log-mel ≈ 6.9 dB (suelo de la métrica 0.9). Es la re-síntesis del modelo:
ni la referencia (solo −42 dB de instrumentos colados) ni la mezcla lo causan.

Qué mueve y qué no (una variable por conversión, tramo de 75 s, ~3 min cada una):

| Prueba | Efecto medido |
|---|---|
| 60 pasos (`diffusionSteps`) | HNR +1 dB, resto igual; 2× de tiempo |
| cfg 0.5 (`cfgRate`) | nada |
| Apollo sobre el stem (`enhanceVocals`) | nada; F0 algo peor |
| referencia de 10 s (`refSeconds`) | **peor** (HNR 9.2) |
| referencia 2º Demucs + DeEcho (`refDenoise`) | nada |
| `match_spectrum` 3 dB / quitado (`glueSpectrumDb`) | solo balance (+3.5 dB de presencia), textura igual |
| `deharshDb: 4` (HPSS, atenúa lo no armónico > 2.5 kHz) | HNR 13.6 = original, planitud 0.23; F0 intacto |
| `keepHighsHz: 3000` (híbrido: agudos del stem original) | HNR 14.3, log-mel 5.6, banda 5–10 k LSD 1.7 (≈ original) |

Veredicto histórico sobre esa canción concreta: crudo ✅, híbrido 3 kHz ✅, candidato por parecido ✅,
conversión completa (60 pasos + deharsh) ❌. El rechazo posterior de Tokio
reemplaza esa recomendación: la UI inicia en «Elegir por parecido» y convertir es experimental.
Todos son mandos opt-in por canción (`options` en `POST /api/songs/[id]/voice`,
`voiceOptions` al crear; `keep_stems=true` en `/convert` guarda los stems para medir).
El modelo de canto ya es el f0_44k con BigVGAN 44k: no hay vocoder mejor que cargar.
Si el usuario sigue oyéndolo sintético, las salidas que **no** re-sintetizan (ya construidas):

- **Elegir en vez de convertir**: `POST /api/songs` con `variants: 4–6` y `voiceMatchId`
  (o «Elegir la generación más parecida» + «candidatos» en el panel; `POST /api/songs/[id]/voice-match`
  para una canción hecha). `:8002/voice-similarity` = coseno de embeddings CAMPPlus sobre el stem
  Demucs, ~10 s/canción. Escala: misma canción de la voz 0.89, otros sintéticos 0.72–0.74, voz hablada
  0.37, cuatro candidatos de la misma letra 0.74–0.85. ≥ 0.8 es solo una heurística local de parecido; confirmar por oído.
  Crear con `voiceId: null` para evitar conversión, aunque se mida parecido.
- **LoRA del artista en ACE-Step**: perfil → «Entrenar la voz (LoRA)» (`POST /api/artists/[id]/lora
  {epochs, rank}`; `lib/lora.ts`). Material = canción origen de la voz + canciones con parecido ≥ 0.8
  (nunca mezclas convertidas). El motor deja de generar mientras entrena; carpeta
  `engine/ACE-Step-1.5/.cache/lora/<artistId>` (fuera de ahí el motor rechaza la ruta). Al crear,
  `useLora` añade el adaptador (`/v1/lora/load` con `adapter_name` = tag, queda activo) y antepone el
  tag `<artista>_voice`; sin LoRA, `/v1/lora/toggle false`. Gotchas: el adaptador está en
  `export/adapter/`; tras entrenar el decoder queda envuelto sin copia base (`unload` falla) y el LM
  descargado → la web llama `/v1/reinitialize`. Al cambiar de artista,
  `applyLoraForGeneration` comprueba el adaptador activo y lo descarga/carga cuando corresponde.
  Humo histórico de 2 épocas: 2 min, sin cambio audible; aumentar épocas no garantiza
  calidad ni identidad. Validar el resultado antes de usarlo como voz del artista.
- Fine-tuning de Seed-VC (`seed-vc/train.py`, preset f0_44k) sigue siendo la opción si hace falta
  convertir canciones ya hechas con mejor timbre.

## Comprobación mínima antes de decir "listo"

- Antes de encolar una generación: la letra pasó la revisión del flujo (sin acotaciones ni
  descripciones de producción, sin paréntesis que no se canten, idioma y género vocal
  correctos). Es lo único que impide que el motor cante "Guitarras limpias y tensas".
  Y pasó el filtro de cantabilidad: líneas de ≤ 10 sílabas, rima en todo el estribillo,
  gancho repetido, sin fechas, diálogos ni cronología del brief.
- En géneros de prior masculino (nu metal, metal, rap, punk) y en cualquier estilo con tags de
  interpretación colectiva (`gang vocals`, `chanted crowd chorus`, `shouted chorus`): el género
  vocal va al principio del estilo y pegado a cada tag de interpretación, y el score se compara
  con la banda histórica del artista antes de entregar; una caída clara significa otro cantante,
  no una toma floja.
- Al crear canciones: audio disponible, referencia correcta y score reportado; distinguir
  candidato generado, parecido medido y consistencia aprobada por oído. Indicar si falta
  alguno. No reiniciar servicios, convertir ni entrenar para dar por completa esta comprobación.
- Al modificar código: ejecutar los checks pertinentes (`make check` para la web). Una
  conversión real solo corresponde a cambios del pipeline de conversión y dentro del alcance
  autorizado; no es requisito para editar documentación o generar sin conversión.
- Al modificar esta skill: validar frontmatter, referencias y coherencia entre `SKILL.md`
  y `api.md`; comprobar que los ejemplos no activan conversión ni entrenamiento por defecto.
- Mantener la documentación del flujo coherente y no atribuir a una métrica garantías auditivas.
