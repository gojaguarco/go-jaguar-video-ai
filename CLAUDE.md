# Go Jaguar Video AI — instrucciones para Claude

Editor de video local que tú (Claude) controlas con comandos. El usuario ve los cambios en vivo en el panel del navegador y puede corregirlos a mano.

**Estilo de respuesta:** corto y directo, en español. Sin explicaciones largas. Una cosa a la vez.

## Primer uso: "instala y abre el editor"

**Mac y Windows (también Linux, menos probado). Necesitas Node 22+ ([nodejs.org](https://nodejs.org)); en Windows con `winget` y Git ya instalados el resto lo hace el instalador.**
1. Revisa qué falta: `npm install` y luego `npm run instalar` (solo revisa: Node, ffmpeg/ffprobe, Python 3.9+, paquetes de Python, whisper-cli y su modelo, modelo de recorte de persona, Chrome, npm de las animaciones).
   - Falta algo → dile al usuario qué es, **pide permiso** y corre `npm run instalar -- --instalar` (usa `brew` en Mac y `winget` en Windows; baja whisper-cli + modelo de 1,5 GB, el entorno de **alineación por audio** (torch, +1,5 GB) y el modelo de recorte de 15 MB; `--sin-modelos` se salta las descargas de modelos). Solo el recorte de persona es opcional (marcado con ·).
   - **La alineación por audio es IMPRESCINDIBLE** (`~/.gojaguar-alinear`, wav2vec2): Whisper solo da el TEXTO y sus tiempos se desfasan hasta ~1 s; la alineación da el segundo exacto de cada palabra (~30–50 ms). Sin ella los cortes, las tomas de apoyo y los subtítulos NO quedan bien. Si falta, no edites: instálala primero.
   - **Windows:** tras instalar con winget **cierra y abre la terminal** (y Claude Code) para que se actualice el PATH, y vuelve a correr `npm run instalar`.
   - **Python:** los scripts `.py` se corren SIEMPRE con `node scripts/py.mjs scripts/<x>.py …` (elige solo `python`/`python3` y el entorno `~/.gojaguar-py`; `--alinear` usa el entorno de torch de la alineación). Nunca `python3 …` a mano (en Windows no existe).
2. Si `npm install` no se hizo, hazlo en la carpeta del proyecto (el instalador también instala `experiments/estilo-3d`).
3. Inicia **en segundo plano**: `npm run dev` → http://127.0.0.1:5273
4. Ábrelo en el panel del navegador. Verás el **Home** (lista de proyectos).

## Cómo se usa (flujo por fases; el usuario lo hace en la interfaz)

Barra de fases arriba: **1 Material → 2 Guion → 3 Propuesta → 4 Editar** (Anterior/Siguiente; se puede retroceder mientras el video no esté en el editor).
1. **Material** (los archivos se ENLAZAN, no se copian; si el original se mueve, *Ubicar*): **Contenido principal** (de aquí sale el guion; es lo único que procesa el botón final **"Recortar silencios y revisar guion"**), **Cámaras adicionales** (se guardan, aún sin usar: PENDIENTE sincronizarlas con el audio del principal), **Tomas de apoyo** (videos/imágenes, SIN audio) y **Referencias** (se quitará cuando los estilos estén entrenados). **4 · Recomendaciones (opcional)**: texto libre del usuario (`analisis/notas-edicion.json`), antes del botón final.
   - Cada toma de apoyo y referencia nueva deja una **hoja de contacto por escenas** (`scripts/escenas-contacto.py`, PySceneDetect+ffmpeg+Pillow; `npm run instalar`): `analisis/apoyo/<toma>/hoja.jpg` + `escenas.json` e índice `analisis/apoyo/<toma>.json` (`descripcion: null` hasta que TÚ la escribas mirando la hoja). **Mira la hoja (1 imagen), nunca fotogramas sueltos.** Referencias: `biblioteca/referencias/<id>.analisis/`.
2. **Guion** (`guion.ts`): secciones con miniatura; el usuario reordena, quita palabras (clic, arrastrar, Mayús+clic) o secciones; muletillas ya quitadas. Estado en `analisis/guion.json`; para LEER usa `analisis/guion-texto.txt` (texto plano, ~5× menos tokens). **Padding de 30 ms en TODOS los cortes** (`PADDING` en `server/guion.ts`): respétalo si cortas tú.
3. **Propuesta** (`propuesta.ts`): pedido **`propuesta`** → `.claude/skills/propuesta-zonas/SKILL.md` escribe `analisis/propuesta.json`. Solo hay zonas donde entra OTRA imagen (toma de apoyo, imagen, video generado, animación 2D/3D); textos, subtítulos, letras y zooms los decides tú (subtítulos virales: sección propia pendiente). Lee SIEMPRE `analisis/notas-edicion.json` (recomendaciones generales del usuario).
4. **Editar**: hasta este botón NO se ha editado nada. Arma el video con el guion (`aplicarGuion`) y deja un pedido **`edicion`**; la app muestra "Editando tu video" con 7 pasos que tú marcas (`npm run progreso -- <slug> <voz|zonas|movimiento|color|textos|revision> <en_curso|hecho|omitido> "detalle"`). Sigue `.claude/skills/edicion-inicial/SKILL.md`. Estilos y REGLA DE MOVIMIENTO (nada >8 s igual): `.claude/skills/estilos/`.
   - Etapas en `analisis/fase.json`: `creacion` → `editando` → `editor`. **Ya en `editor` NO se vuelve a las fases de creación** (API 409): lo grande va por el chat o a mano. Los proyectos anteriores cuentan como `editor`.
5. **Editor**: línea de tiempo para corregir a mano. El usuario también puede pedirte cosas por el chat.

## Al empezar: vigila los pedidos de la app

Arranca en segundo plano `npm run vigilar`: termina imprimiendo `PEDIDO {json}` (`id`, `slug`, `tipo`: `propuesta`|`edicion`; los antiguos `errores`/`completa` ya no se crean). Al recibirlo: `npm run solicitud -- <id> en_curso` → ejecuta el pedido con su skill → `npm run solicitud -- <id> hecho` (o `error "motivo"`) → **vuelve a arrancar `npm run vigilar`**. Los pedidos viven en `biblioteca/solicitudes/*.json`.

## Referencias en el editor (qué subió y qué seleccionó el usuario)

En el panel derecho del editor hay dos pestañas, **Medios** y **Referencias**. En Referencias el usuario importa videos (diálogo del sistema; se enlazan, no se copian), los **selecciona** tocándolos (✓ dorado) y se ordenan con un criterio MIXTO: lo nuevo y lo que más (y más recientemente) se usa va primero (`puntaje` = 45 % recencia de subida, decae en ~10 días + 55 % frecuencia de uso, decae en ~45 días; el uso cuenta proyectos distintos que la eligieron + pedidos a Claude que la incluyeron, y se guarda en `biblioteca/referencias/uso.json`).

**Cómo saber qué referencia se subió o seleccionó (léelo SIEMPRE antes de actuar cuando el usuario diga "la referencia", "la nueva referencia", "el video que acabo de subir", etc.):** `biblioteca/proyectos/<slug>/referencias-activas.json` (la app lo actualiza solo en cada cambio): `seleccionadas` (las que el usuario tiene marcadas ahora: nombre, ruta del video, si ya tienen `perfilDeEstilo`), `ultimaSubida` (la subida más reciente y si está seleccionada) y `eventos` (últimos 20: `subida` / `seleccionada` / `deseleccionada` con fecha). "La nueva referencia" = la `ultimaSubida` (o el evento `subida` más reciente). Analízala por su `ruta` (cortes por escena, fotogramas, subtítulos, paleta, zooms) y guarda su perfil en `biblioteca/referencias/<nombre>.estilo.json`; si ya hay perfil, reúsalo.

**Navegación:** en el editor ya no hay botón "Proyectos": el logo guarda y lleva a la página principal (todos los proyectos). Desde allí, un proyecto con edición abre DIRECTO el editor; la página de proyecto (material, prompt, referencias, botón "Recorta silencios") solo se ve para proyectos sin edición, o sea para la primera edición.

## La biblioteca (media lake)

Carpeta `biblioteca/` (configurable con `GOJAGUAR_BIBLIOTECA`; no va a git):

```
biblioteca/
  proyectos/<slug>/
    proyecto.json          nombre, idioma, referencias elegidas, assets
    proyecto.gojaguar      la edición (formato del core)
    analisis/              silencios (<video>.silencios.json) y ritmo de la música (<pista>.ritmo.json)
    material/              solo COPIAS (si no se pudo enlazar). Los videos normales se ENLAZAN: su ruta está en proyecto.json → material[].ruta
    proxies/               copias livianas para editar
    transcripciones/       <video>.lineas.txt y .words.json
    analisis/              silencios
    salidas/               renders finales (futuro)
  referencias/             <id>.ref.json (enlaces) o copias, y <nombre>.estilo.json (compartidas por todos los proyectos)
```

## Procedimientos estándar de TODA edición
**Antes de cortar, poner o borrar tomas: tiempos por palabra con la alineación por audio** (`node scripts/py.mjs --alinear scripts/alinear-palabras.py …`, guía 14), nunca con los tiempos crudos de Whisper; luego `verificar-sincronia.py`.

### Rápido y con pocos tokens (medido en Windows; respétalo siempre)
- **Alinea TODOS los videos en UNA llamada** (el modelo de ~1,2 GB se carga una vez): `node scripts/py.mjs --alinear scripts/alinear-palabras.py a.wav a.words.json a.palabras.json b.wav b.words.json b.palabras.json …` (4 videos: ~45 s en vez de ~2,5 min).
- **Sincronía de subtítulos SIN exportar**: `node scripts/audio-linea.mjs <slug>` (audio de la línea de tiempo en <1 s) y `node scripts/py.mjs scripts/verificar-sincronia.py <ese.wav> biblioteca/proyectos/<slug>/proyecto.gojaguar` (Whisper se carga una vez para todas las ventanas: ~2 min). Lee también subtítulos de UNA palabra.
- `analizar-color.py` tarda ~3–4 s por tramo: lánzalo para todos los clips en la MISMA orden de terminal, no uno por turno.
- Revisa con `editor.verificar()` + `editor.hoja(0, [momentos])` (~4 s, una imagen) y `editor.describe('corto')`; nada de capturas sueltas ni exportaciones de prueba.
- **Ojo con el inicio de los videos**: suele haber una cuenta "1, 2, 3" que Whisper NO transcribe (pone la primera palabra en 0 s). Corta siempre con los tiempos de `analisis/<video>.palabras.json` (alineados), no con los de `guion.json`.
- **Tras cortar o borrar clips, recoloca los subtítulos**: no se mueven solos con un recorte hecho a mano y `delete_clip` puede borrar capas que lo tocan. Recalcula cada subtítulo desde `palabras.json` con los clips actuales (conserva los textos que el usuario cambió).
- `py.mjs` ya añade `~/.gojaguar-bin` (whisper-cli) y WinGet\Links (ffmpeg) al PATH: no hace falta tocarlo a mano.
Guion (lo revisa el usuario en la app), muletillas (`docs/guia/15-…`), voz limpia y pareja y luces/color (pasos `voz` y `color` de `.claude/skills/edicion-inicial/SKILL.md`). El estilo (`.claude/skills/estilos/`) se aplica encima.

## Ejecutar una orden del chat
Proyecto = `slug` (o el abierto en el panel); texto en `analisis/guion-texto.txt`; abre `http://127.0.0.1:5273/#/editor/<slug>` y aplica con `editor.batch([...])` (se guarda solo). Muestra al usuario qué hiciste y qué falta.

## Controlar el editor (desde el panel)

`window.editor` existe en la página del editor. Úsalo con la herramienta de JavaScript del navegador. **Para ahorrar tokens: `editor.describe('corto')` (resumen), `editor.verificar()` (revisión numérica: regla de movimiento y avisos) y `editor.hoja()` (UNA imagen con ~12–16 momentos, guardada en `analisis/hoja-edicion.jpg`: léela con Read) en lugar de varias capturas.**

```js
editor.describe()                      // resumen compacto (léelo ANTES de editar)
editor.batch([ {op:'delete_clip', id:'c1'}, {op:'add_clip', asset:'a1', src_in:4.2, src_out:17.6}, {op:'speed_all', value:1.1} ])
editor.exec({ op: 'delete_ranges', ranges: [[10,12],[30,31]] })
await editor.bench()                   // mide scrub y reproducción (pestaña visible)
```

Comandos (`op`): `import_asset`, `add_clip {asset,src_in,src_out}`, `set_zoom {clip,zoom:{kind:'push'|'pull'|'punch',amount,duration?}|null}` (el ZOOM es un efecto del clip: intensidad en 0,02–0,8; `duration` solo en `punch`), `set_clip_color {clip,color:{brillo,contraste,saturacion}|null}` (luces y color del clip, 1 = sin cambio; brillo 0,5–1,8, contraste 0,6–1,6, saturación 0–2; la vista previa usa el filtro del lienzo y la exportación `lutrgb`+`colorchannelmixer`, misma fórmula), `set_audio_fx {on}` (voz limpia y pareja de todo el proyecto), `set_clip_transform {clip,transform:{x,y,scale,rotation}|null}` (mover/agrandar/girar el VIDEO de un clip sin deformarlo: x,y = centro 0..1, scale 1 = entero dentro del cuadro, rotation en grados; `null` lo deja ajustado y centrado), `set_transition {clip,transition:{kind:'slide'|'flash'|'dip',duration,intensity,dir?}|null}` (la TRANSICIÓN vive en el corte: `clip` es el clip que ENTRA; es una sola y su mitad cae al final del clip anterior (salida) y la otra mitad al inicio de este (entrada); el primer clip no tiene), `set_music {asset,src_in,volume,fade_out}` (pista de música desde el inicio; el asset es `kind:'audio'` con `proxy` = la vista previa `.previews/<id>.m4a`), `clear_music`, `set_format {width,height}` (vertical: 1080×1920), `add_overlay {asset,start,track?,src_in?,src_out?,x?,y?,scale?,volume?}` (clip de video o audio superpuesto, libre en el tiempo; `track` 1,2,3… por tipo; si se solapa con otro se abre otra pista sola), `clip_to_overlay {clip,start,track?}` (lo que hace arrastrar un clip de la pista principal hacia arriba: sale de la principal, que se cierra, y pasa a una pista de video superpuesta a tamaño completo), `update_overlay {id,patch:{start,track,srcIn,srcOut,speed,volume,transform,crop,mascara,transicion}}` (`mascara {x,y,w,aspect,r}` = ventana tipo card; `transicion` 'fundido'|'subir'|'3d'), `delete_overlay {id}`, `set_track {track,locked?,hidden?,muted?}` (claves: `main`, `music`, `subtitle`, `graphic`, `v1`,`v2`… video superpuesto, `a1`,`a2`… audio extra; bloquear no deja editar la pista, ocultar la quita de la vista previa y del MP4, silenciar quita su audio), `split {at}`, `delete_range {from,to}`, `delete_ranges {ranges}`, `delete_clip {id}`, `speed {clip,value}`, `speed_all {value}`, `volume {clip,value}`, `move_clip {id,to_index}`, `trim {id,edge,src_time}`, `add_text {type:'subtitle'|'graphic',start,end,text,…}`, `add_layer`, `update_layer`, `delete_layer`. Definición: `packages/core/src/commands.ts`.

El editor es responsive: la cabecera se compacta por pasos solo cuando NO cabe (≤780 px "Proyectos" queda solo con la flecha; ≤720 px "Guardado" pasa a ✓; ≤640 px se oculta "VIDEO AI"; ≤520 px Exportar queda solo con su icono); no ocultes el texto "VIDEO AI" a anchos normales (el panel del usuario mide ~909 px). Bajo 860 px el panel derecho (medios y propiedades) pasa a ser un menú que entra desde la derecha con el botón del panel de la cabecera (se cierra tocando fuera o con Esc). Al probar anchos con `resize_window`, volver a `preset desktop`. El panel derecho del editor, sin nada seleccionado, es la **biblioteca de medios** (como CapCut): botón Importar (diálogo del sistema; los archivos se enlazan y `POST /api/proyectos/:slug/preparar` crea el proxy/audio para el editor), búsqueda, tarjetas con fotogramas u onda, insignia "Agregado", y se arrastran a una pista (o botón "+" en el cabezal). Arriba lleva el título **Medios** y filtros Todo/Videos/Audio. Las **imágenes** (jpg, png, webp, avif, heic…) también se importan con el mismo botón (lo que no es compatible se AVISA en el panel, nunca se descarta en silencio; las fotos se ven en una cuadrícula de vistas cuadradas): quedan como copia liviana `proxies/<nombre>.img.jpg|png` (máx. 2160 px; la original no se toca), aparecen en la pestaña "Imágenes" de Medios con la etiqueta Foto y se arrastran a una pista de video superpuesto como un clip de 4 s (se estira con el borde, lleva posición, tamaño, giro y opacidad como cualquier superpuesto; un PNG con transparencia la conserva). Comando: `add_overlay {asset, start, src_out?}` con un asset de tipo `image`. Cualquier superpuesto (video o imagen) admite `crop {l,t,r,b}` (fracciones 0–0,45 de cada borde) con `update_overlay {id, patch:{crop}}`: quita barras negras o subtítulos quemados de una toma de apoyo sin deformarla (vista previa y exportación). Receta de B-roll en vertical: tomas 16:9 como CARD 4:5 con máscara y entrada/salida 3D (ver "Reglas de la edición con apoyo visual"); el audio de la toma de apoyo va en `volume 0`. Los controles de la música aparecen al tocar su pista.

En el editor (línea de tiempo estilo CapCut) el usuario ve los **zooms** como una etiqueta dentro del clip y las **transiciones** como una pastilla blanca en el corte (su ancho es la duración). Al seleccionar un clip, el panel derecho tiene tres secciones separadas: **Efecto** (hoy el único efecto es Zoom: tipo acercar/alejar/golpe, intensidad, duración del golpe), **Transición de entrada** y **Transición de salida** (tipo, duración total, intensidad, dirección; la de salida de un clip es la de entrada del siguiente). Con nada seleccionado se ve la biblioteca de medios. Al pasar el mouse por la línea de tiempo (o arrastrar el cabezal) este se **pega como imán a los cortes**; al tocar el corte entre dos clips (pastilla "+") se abre un menú para poner o quitar la transición. No se ofrece en los cortes de un clip seleccionado (el usuario selecciona clips para ajustar tiempos); en el resto sí. Si el usuario cambia algo a mano, el MP4 de `salidas/` queda desactualizado: hay que re-renderizar.

Reglas:
- **Nunca borres, muevas ni renombres los videos originales del usuario** (están enlazados, no copiados). Quitar algo de la app solo quita el enlace.
- **Usa lotes** (`editor.batch`, `delete_ranges`, `speed_all`), no cientos de llamadas.
- `add_clip` en el orden final permite **reordenar** (gancho primero).
- Los tiempos de `delete_ranges` son de la línea de tiempo **actual**.
- Cada `exec`/`batch` es **una** entrada de deshacer.
- No renderices para ver un cambio: la vista previa es en vivo.
- Ediciones no destructivas (nunca tocan los originales).

## Guía detallada (índice por temas: lee SOLO el archivo que toques)

`docs/GUIA-DEL-EDITOR.md` es un índice; cada tema vive en `docs/guia/NN-*.md` (música/imágenes, efectos de sonido, formato, reproductor, voz/color/dB, selección múltiple, **plantillas de gráficos + reglas de apoyo visual (07)**, recorte de persona, atajos, subtítulos y karaoke (**sincronía obligatoria**), muletillas, momentos sin voz, proxies, escenas animadas, color de marca). Reglas de oro: nunca tocar los originales; lotes en vez de llamadas sueltas; no exportar pruebas; nada solo de Mac; SFX solo swooshes de aire suaves; sin comillas en subtítulos.

## Recursos ilustrativos para Remotion (mínimos tokens)
- **Escalera de ilustración (2D minimalista primero; 3D solo si hace falta) y comando `scripts/ilustrar.py` (render + transparencia + caché en una llamada): `.claude/skills/ilustraciones/SKILL.md`. Léelo antes de ilustrar.**
- **Una sola llamada:** `node scripts/py.mjs experiments/estilo-3d/scripts/assets.py traer <icono|modelo|hdri|textura> <palabras en inglés>` → busca, elige el primero y lo baja a `public/assets/` (reutiliza lo ya descargado); imprime UNA línea (~20 tokens). Úsalo con `staticFile()`. NUNCA abras ni imprimas el archivo (SVG/gltf).
- Si el primero no sirve: `assets.py buscar <tipo> <palabras>` (≤5 líneas) y `assets.py bajar <tipo> <id>`; `assets.py categorias <tipo>` para afinar. NO consultes las APIs a mano (Iconify devuelve ~5k tokens de metadatos; Poly Haven, listas enormes).
- Iconos: solo MIT / Apache-2.0 / CC0 (el script descarta el resto). 3D/HDRI/texturas: Poly Haven, CC0, resolución 1k por defecto. Todo se registra en `public/assets/credits.json`.
- 3D solo si el 2D no alcanza; Poly Haven es sobre todo utilería (muebles, plantas, herramientas): para un producto concreto no habrá modelo. Sin Blender MCP ni MCP de iconos.
- Responde breve; no resumas paso a paso lo que hiciste.

## Aprendizaje del estilo del usuario (casi 0 tokens)
El editor anota lo que el usuario hace a mano; `scripts/aprender.py` (código, sin Claude) lo funde en `biblioteca/aprendizaje/perfil.json` y regenera `estilo-usuario.md`. **Lee ese .md (≈400 tokens) antes de proponer o editar; nunca el perfil ni los logs.** Solo si hay notas cualitativas nuevas llega un pedido `aprendizaje` (skill `aprender-estilo`). Cuando el usuario pida un cambio general por el chat, anótalo: `npm run nota-estilo -- <slug> "preferencia corta"`.

## Verificación previa (nada entra a editar con archivos faltantes)
`verificarProyecto` (`server/api.ts`): antes de **Editar** y al abrir el **editor** revisa ffmpeg, guion con contenido, y que existan las copias livianas de todos los videos (el original solo hace falta para exportar: es un aviso). Si falta algo, la app muestra qué y ofrece **Reparar** (regenera la copia liviana desde el original) en vez de quedarse en "Cargando…"; `GET /api/proyectos/:slug/verificacion?para=editar|editor`, `POST …/reparar`.

## Estructura del código

- `packages/core` — modelo, comandos, historial, guardar/abrir. Sin navegador. Con pruebas (`npm test`).
- `packages/app` — interfaz (`src/`), motor de vista previa y **API local** (`server/api.ts`: biblioteca, subidas, procesamiento, tareas).
- `docs/` — `PLAN.md`, `PRODUCTO.md`, `BENCHMARKS.md`.

Antes de cambiar código: `npm test` y `npm run check` deben pasar.

## Límites actuales (no prometas lo que no existe)

- **3D con Remotion/three.js: probado con transparencia** (MP4 "pack" color|alfa, assets con `alfa:'pack'`; receta en `docs/guia/07-…`). Falta la biblioteca de composiciones parametrizadas y el comando que renderiza e importa en un paso.

- Los textos (subtítulos y gráficos) salen en el MP4: la exportación los dibuja con un Chromium sin pantalla (`server/rotulos.ts` + página `src/render.ts`, el MISMO código de `overlays.ts` que usa el editor) como PNG con transparencia y ffmpeg los superpone. Si un rótulo se ve distinto en el MP4, el cambio va en `overlays.ts`. Rótulo animado: capa `graphic` con `template:'lanzamiento'` y `props:{linea1,linea2,modelo,marca (ruta api/files/… del logo blanco con transparencia),acento}`.
- **La exportación pregunta la carpeta** (campo "Guardar en" con botón Cambiar…, diálogo nativo del sistema vía `POST /api/carpeta`), recuerda la última en `biblioteca/configuracion.json` (por defecto `~/Movies`) y deja el MP4 final en esa carpeta, no en la biblioteca; lo exportado se registra en `biblioteca/exportaciones.json` (solo esas rutas se sirven o se muestran en el Finder).
- **El video se exporta desde la app** (botón **Exportar** del editor: resolución, calidad, progreso, descargar). El servidor renderiza la edición actual con ffmpeg (`server/exportar.ts`: cortes, zoom/transiciones, superpuestos, audio de clips, música). **Nunca le envíes el video al usuario por el chat ni lo renderices tú a mano**; si algo falta en la exportación, se arregla en `exportar.ts`.
- 3D, zoom y subtítulos animados viven solo en `experiments/estilo-3d`; no son capas del editor.
- El análisis de referencias lo haces tú (Claude) cuando el usuario pide la edición completa; la app no lo hace sola.
- Recorte de persona: `scripts/recortar-persona.py` (Robust Video Matting, ONNX, **Mac y Windows**; guía 08). `experiments/estilo-3d/scripts/matte.swift` (Apple Vision) es un experimento solo de Mac: no lo uses.
- Desarrollado y probado en Mac. Windows: el código está preparado (diálogos con PowerShell, whisper-cli.exe, sin aceleración por hardware) pero aún sin verificar de punta a punta; si algo falla, repórtalo y arréglalo en el código. Arrastrar y soltar archivos en la interfaz no está probado por mí (sí la subida por API y el procesamiento).
