"""
Revisión de sincronía de subtítulos karaoke contra el AUDIO REAL. Correrla SIEMPRE después de alinear palabras y antes de dar el video por listo.

Uso:  node scripts/py.mjs verificar-sincronia.py <audio> <palabras.json | proyecto.gojaguar>
  · con palabras.json: tiempos del archivo de origen contra su audio (mismo audio que usó el alineador).
  · con proyecto.gojaguar: lee las palabras de las capas karaoke (tiempos de la LÍNEA DE TIEMPO) y las compara con el audio del MP4 YA EXPORTADO
    (ffmpeg -i export.mp4 -vn -ac 1 -ar 16000 audio.wav). Es la prueba de punta a punta: incluye cortes, orden y velocidad.
Mide, para cada palabra (y además re-transcribe ventanas de 4 palabras: la 1.ª y la última deben oírse completas, o sea que no están cortadas por un desfase):
  - voz: que su mitad central NO caiga en silencio real (una palabra puesta sobre una pausa es desfase seguro);
  - ataque: distancia entre su inicio y el ataque de energía más cercano (en habla continua, la mayoría debe quedar < 80 ms);
  - cobertura: que las pausas largas (≥ 0,25 s) caigan entre palabras, no dentro de una.
Sale con código 1 si falla (voz sobre silencio > 3 %, ataque mediano > 90 ms o > 4 pausas largas dentro de una palabra). Imprime las palabras sospechosas.
"""
import json, re, subprocess, sys
import numpy as np

wav, pj = sys.argv[1:3]
J = json.load(open(pj, encoding='utf-8'))
if isinstance(J, dict):
    P = []
    for l in J['project']['layers']:
        if l.get('type') == 'subtitle' and l.get('template') == 'karaoke':
            P += [{'w': w, 't0': a, 't1': b} for w, a, b in json.loads(l['props']['palabras'])]
        elif l.get('type') == 'subtitle' and not l.get('template') and len(l.get('text', '').split()) == 1:
            P.append({'w': l['text'], 't0': l['start'], 't1': l['end'], 'simple': True})   # subtítulo de UNA palabra (estilo palabra por palabra)
    P.sort(key=lambda x: x['t0'])
else: P = J
raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', wav, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'])
pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
HOP = 160; n = len(pcm) // HOP
db = 20 * np.log10(np.sqrt(np.mean(pcm[:n * HOP].reshape(n, HOP) ** 2, axis=1) + 1e-10))
sm = np.convolve(db, np.ones(3) / 3, mode='same')
onset = np.maximum(0, np.convolve(np.diff(sm, prepend=sm[0]), np.ones(3) / 3, mode='same'))
picos = [k for k in range(2, n - 2) if onset[k] > 1.2 and onset[k] >= onset[k - 1] and onset[k] >= onset[k + 1]]
picos = np.array(picos) / 100.0
umbral = max(np.percentile(db, 10) + 6, -45)                 # "silencio" = cerca del piso de ruido
silencio = db < umbral

malas_voz, dist, largas_dentro = [], [], []
for q, x in enumerate(P):
    a, b = x['t0'], x['t1']
    if x.get('simple'): b = min(b, a + 0.3)      # subtítulo de una palabra: su fin es el tiempo en pantalla (puede seguir en la pausa), no el fin de la voz
    c0, c1 = int((a + (b - a) * 0.25) * 100), int((a + (b - a) * 0.75) * 100)
    if c1 > c0 and silencio[c0:c1 + 1].mean() > 0.7: malas_voz.append((q, x['w'], a))
    if len(picos): dist.append(abs(picos - a).min())
    k0, k1 = int(a * 100), min(n, int(b * 100) + 1)
    run = mx = 0
    for v in silencio[k0:k1]:
        run = run + 1 if v else 0; mx = max(mx, run)
    if mx >= 25 and b - a > 0.35 and not x.get('simple'): largas_dentro.append((q, x['w'], a, mx / 100))
dist = np.array(dist) if dist else np.array([0.0])
med = float(np.median(dist)) * 1000; p80 = float((dist < 0.08).mean()) * 100
print(f'{len(P)} palabras | voz sobre silencio: {len(malas_voz)} ({100 * len(malas_voz) / len(P):.1f} %) | ataque mediano: {med:.0f} ms | dentro de 80 ms: {p80:.0f} % | pausas largas dentro de una palabra: {len(largas_dentro)}')
for q, w, a in malas_voz[:12]: print(f'  ✗ "{w}" en {a:.2f}s cae sobre silencio')
for q, w, a, s in largas_dentro[:8]: print(f'  ✗ "{w}" en {a:.2f}s contiene una pausa de {s:.2f}s')
# prueba independiente: ventanas de 4 palabras recortadas del audio y transcritas aparte
import difflib, os, tempfile
norm = lambda t: re.sub(r'[^\wáéíóúñü ]', '', t.lower())
MOD = os.path.expanduser('~/.whisper-models/ggml-medium.bin'); cortadas = []; probadas = 0
import wave
ventanas = []
for q in range(0, len(P) - 4, max(4, (len(P) - 4) // 14)):
    g = P[q:q + 4]; a, b = max(0, g[0]['t0'] - 0.1), g[-1]['t1'] + 0.1
    if b - a >= 0.8: ventanas.append((q, g, a, b))
# TODAS las ventanas en UNA sola llamada a Whisper (el modelo de 1,5 GB se carga una vez, no una por ventana: de ~10 min a ~1 min).
# Se recortan del audio que ya está en memoria (16 kHz mono), sin un ffmpeg por ventana.
with tempfile.TemporaryDirectory() as d:
    archivos = []
    for k, (q, g, a, b) in enumerate(ventanas):
        f = os.path.join(d, f'w{k}.wav'); archivos.append(f)
        with wave.open(f, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes((np.clip(pcm[int(a * 16000):int(b * 16000)], -1, 1) * 32767).astype(np.int16).tobytes())
    if archivos:
        subprocess.run(['whisper-cli', '-m', MOD, '-l', 'es', '-mc', '0', '-otxt', '-np', '-t', str(os.cpu_count() or 4)] + [x for f in archivos for x in ('-f', f)], capture_output=True)
    for k, (q, g, a, b) in enumerate(ventanas):
        o = archivos[k] + '.txt'
        txt = norm(open(o, encoding='utf-8', errors='replace').read()) if os.path.exists(o) else ''
        probadas += 1
        esp = norm(''.join(x['w'] for x in g))
        if difflib.SequenceMatcher(None, esp, txt.replace(' ', '')).ratio() < 0.6: cortadas.append((q, ' '.join(x['w'] for x in g), a))      # Whisper confunde alguna palabra: se compara el parecido, no palabra por palabra
print(f'ventanas re-transcritas: {probadas} | que no se parecen a su texto (desfase grueso): {len(cortadas)}')
for q, t, a in cortadas[:8]: print(f'  ✗ "{t}" ({a:.2f}s): su ventana de audio dice otra cosa')
ok = len(cortadas) <= max(1, probadas // 5) and len(malas_voz) <= 0.03 * len(P) and med <= 90 and len(largas_dentro) <= 4
print('SINCRONÍA OK' if ok else 'SINCRONÍA MALA: realinear o anclar a mano antes de seguir')
sys.exit(0 if ok else 1)
