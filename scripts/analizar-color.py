"""
Luces y color de un tramo de video: mide cuadros reales y propone brillo / contraste / saturación para `set_clip_color`.

Uso:  node scripts/py.mjs analizar-color.py <video> <inicio_s> <fin_s> [--json]
Toma 7 cuadros repartidos entre inicio y fin (del proxy o del original), mide luz (media y extremos) y saturación, y busca el par (brillo, contraste)
que acerca la imagen a una luz "bonita y natural": media ~0,50, sombras ~0,06 y luces ~0,93 sin quemar. La fórmula es LA MISMA del editor
(brillo → contraste → saturación, canal por canal en RGB), así que lo que predice es lo que se verá.
Después SIEMPRE mirar un cuadro antes/después (ver el paso `color` de .claude/skills/edicion-inicial/SKILL.md): los números proponen, el ojo decide
(piel natural, cielo sin quemar, nada de colores exagerados).
"""
import json, subprocess, sys
import numpy as np

video, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
W, H, N = 192, 340, 7
ts = [t0 + (t1 - t0) * (i + 0.5) / N for i in range(N)]
def cuadro(t):
    return subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1', '-vf', f'scale={W}:{H}:force_original_aspect_ratio=decrease', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(N) as ex: raws = list(ex.map(cuadro, ts))     # los 7 cuadros a la vez
frames = [np.frombuffer(raw, dtype=np.uint8).astype(np.float32).reshape(-1, 3) / 255.0 for raw in raws if len(raw) >= 3 * 16]
if not frames: sys.exit('no pude leer cuadros del video')
px = np.concatenate(frames)
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

def medir(a):
    y = a @ LUMA; mx, mn = a.max(axis=1), a.min(axis=1)
    sat = np.where(mx > 0.02, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return {'media': float(y.mean()), 'sombras': float(np.percentile(y, 3)), 'luces': float(np.percentile(y, 97)), 'saturacion': float(sat[y > 0.08].mean() if (y > 0.08).any() else 0), 'quemado': float((a.max(axis=1) > 0.985).mean())}

def aplicar(a, b, c, s):
    x = np.clip(a * b, 0, 1); x = np.clip((x - 0.5) * c + 0.5, 0, 1)
    g = (x * np.array([0.213, 0.715, 0.072], dtype=np.float32)).sum(axis=1, keepdims=True)
    return np.clip(g + (x - g) * s, 0, 1)        # equivale a la matriz de saturación de CSS/ffmpeg

antes = medir(px)
OBJ = {'media': 0.50, 'sombras': 0.06, 'luces': 0.93}
MUESTRA = px[::7]
def costo(b, c):
    m = medir(aplicar(MUESTRA, b, c, 1.0))
    return (m['media'] - OBJ['media']) ** 2 * 3 + (m['sombras'] - OBJ['sombras']) ** 2 + (m['luces'] - OBJ['luces']) ** 2 * 2 + max(0, m['quemado'] - 0.004) * 12 + max(0, 0.03 - m['sombras']) * 25 + ((b - 1) ** 2 + (c - 1) ** 2) * 0.08
# búsqueda en dos pasadas (gruesa y luego fina alrededor de la mejor): ~200 pruebas en vez de 1.479, mismo resultado (el costo es suave)
mejor = min((costo(b, c), float(b), float(c)) for b in np.arange(0.6, 1.61, 0.1) for c in np.arange(0.85, 1.41, 0.05))
_, b0, c0 = mejor
mejor = min([mejor] + [(costo(b, c), float(b), float(c)) for b in np.arange(max(0.6, b0 - 0.1), min(1.6, b0 + 0.1) + 1e-6, 0.02) for c in np.arange(max(0.85, c0 - 0.05), min(1.4, c0 + 0.05) + 1e-6, 0.02)])
_, B, C = mejor
S = float(np.clip(0.30 / max(antes['saturacion'], 0.05), 0.9, 1.3))
despues = medir(aplicar(px, B, C, S))
res = {'brillo': round(B, 2), 'contraste': round(C, 2), 'saturacion': round(S, 2), 'antes': {k: round(v, 3) for k, v in antes.items()}, 'despues': {k: round(v, 3) for k, v in despues.items()}, 'cuadros': len(frames)}
if '--json' in sys.argv: print(json.dumps(res, ensure_ascii=False))
else:
    print(f"cuadros {len(frames)} | antes: media {antes['media']:.2f} sombras {antes['sombras']:.2f} luces {antes['luces']:.2f} sat {antes['saturacion']:.2f} quemado {antes['quemado'] * 100:.1f} %")
    print(f"propuesta: brillo {B:.2f} contraste {C:.2f} saturación {S:.2f}  →  media {despues['media']:.2f} sombras {despues['sombras']:.2f} luces {despues['luces']:.2f} sat {despues['saturacion']:.2f} quemado {despues['quemado'] * 100:.1f} %")
    print(f"set_clip_color: {{brillo: {B:.2f}, contraste: {C:.2f}, saturacion: {S:.2f}}}")
