## Subtítulos karaoke: sincronía con la voz (OBLIGATORIO revisarla)

Los tiempos por palabra de Whisper se desfasan (hasta ~1 s), así que **no se usan** para karaoke. Pasos, siempre:
1. Audio de origen: `ffmpeg -i <proxy o video> -vn -ac 1 -ar 16000 audio.wav`.
2. Alinear: `node scripts/py.mjs --alinear scripts/alinear-palabras.py audio.wav transcripciones/<video>.words.json analisis/<video>.palabras.json` (alineación forzada CTC con wav2vec2 en español, Apache 2.0). Instalación única y gratuita (~1,5 GB, pedir permiso antes): `python3 -m venv ~/.gojaguar-alinear && ~/.gojaguar-alinear/bin/pip install torch torchaudio transformers soundfile numpy`.
3. Revisar: `node scripts/py.mjs scripts/verificar-sincronia.py audio.wav analisis/<video>.palabras.json` (voz sobre silencio, pausas dentro de palabras, ventanas re-transcritas). Si dice `SINCRONÍA MALA`, no seguir.
4. Armar las capas karaoke (o subtítulos de una palabra) con los tiempos pasados a la línea de tiempo (en los cortes, restar lo eliminado) y revisar de punta a punta SIN exportar: `node scripts/audio-linea.mjs <slug>` (audio de la línea de tiempo en <1 s) y `node scripts/py.mjs scripts/verificar-sincronia.py <ese.wav> biblioteca/proyectos/<slug>/proyecto.gojaguar`.
5. **Sin comillas** (`"` `“` `”` `«` `»`) en el texto de los subtítulos ni en sus palabras: el usuario las quita siempre.
6. Si escribiste `proyecto.gojaguar` en disco con el editor abierto, **recarga la página del editor** (`location.reload()`): no detecta cambios externos, sigue mostrando (y guardando) la versión vieja. Comprueba con `JSON.parse(editor.serialize())`.
7. Mirar a ojo 2-3 zonas (energía vs palabras) antes de decir "listo".
