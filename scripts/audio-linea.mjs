#!/usr/bin/env node
// Audio de la VOZ tal como suena en la línea de tiempo actual (pista principal: cortes, orden y velocidad), en ~1 s y SIN exportar.
// Sirve para revisar la sincronía de los subtítulos contra el audio real sin esperar una exportación completa:
//   node scripts/audio-linea.mjs <slug> [salida.wav]
//   node scripts/py.mjs scripts/verificar-sincronia.py <salida.wav> biblioteca/proyectos/<slug>/proyecto.gojaguar
// Usa las copias livianas (proxies) del proyecto; no toca los originales. Salida: WAV mono 16 kHz.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [slug, salidaArg] = process.argv.slice(2)
if (!slug) { console.error('Uso: node scripts/audio-linea.mjs <slug> [salida.wav]'); process.exit(2) }
const bib = process.env.GOJAGUAR_BIBLIOTECA ?? join(raiz, 'biblioteca')
const pdir = join(bib, 'proyectos', slug)
const { project: p } = JSON.parse(readFileSync(join(pdir, 'proyecto.gojaguar'), 'utf8'))
const salida = salidaArg ?? join(tmpdir(), `${slug}.linea.wav`)

const archivo = id => {
  const a = p.assets.find(x => x.id === id)
  const f = join(bib, a.proxy.replace(/^api\/files\//, ''))
  return existsSync(f) ? f : a.original
}
const ins = [], fil = []
p.clips.forEach((c, k) => {
  ins.push('-i', archivo(c.assetId))
  const tempo = c.speed === 1 ? '' : `,atempo=${c.speed}`
  fil.push(`[${k}:a]atrim=${c.srcIn}:${c.srcOut},asetpts=PTS-STARTPTS${tempo},volume=${c.volume ?? 1}[a${k}]`)
})
fil.push(p.clips.map((_, k) => `[a${k}]`).join('') + `concat=n=${p.clips.length}:v=0:a=1[out]`)
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...ins, '-filter_complex', fil.join(';'), '-map', '[out]', '-ac', '1', '-ar', '16000', salida], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
const dur = p.clips.reduce((t, c) => t + (c.srcOut - c.srcIn) / c.speed, 0)
console.log(`${salida}  (${dur.toFixed(2)} s, ${p.clips.length} clips)`)
