import type { Clip, Layer, OverlayClip, Project } from './types'

/** Duración mínima de cualquier tramo (≈ 2 frames a 30 fps). */
export const MIN_DUR = 1 / 15

export const clipDur = (c: Clip) => (c.srcOut - c.srcIn) / c.speed

export interface Placed { clip: Clip; start: number; end: number }

/** Posiciona los clips de la pista principal uno tras otro. */
export function layout(p: Project): Placed[] {
  let t = 0
  return p.clips.map(clip => {
    const start = t
    t += clipDur(clip)
    return { clip, start, end: t }
  })
}

/** Duración de la pista principal. */
export const mainDuration = (p: Project) => p.clips.reduce((s, c) => s + clipDur(c), 0)

export const overlayDur = (o: OverlayClip) => (o.srcOut - o.srcIn) / o.speed
export const overlayEnd = (o: OverlayClip) => o.start + overlayDur(o)

/** Duración total: lo más lejos que llega la pista principal o cualquier clip superpuesto. */
export const duration = (p: Project) => (p.overlays ?? []).reduce((m, o) => Math.max(m, overlayEnd(o)), mainDuration(p))

// --- pistas de TEXTO (subtítulos y gráficos): como las de video, nunca una capa detrás de otra ---------------------------------
export type TipoTexto = 'subtitle' | 'graphic'
export const pistaTexto = (l: Layer) => l.track ?? 1
const pisa = (a: Layer, s: number, e: number) => a.start < e - 1e-6 && a.end > s + 1e-6
/** Número de pistas de un tipo de texto en uso. */
export const textTrackCount = (p: Project, tipo: TipoTexto) => p.layers.reduce((m, l) => (l.type === tipo ? Math.max(m, pistaTexto(l)) : m), 0)
/**
 * Pista donde cabe [start, end) para un texto: la `preferida` (la que está bajo el mouse) si está libre; si no, la pista existente libre más cercana
 * (efecto imán a la pista secundaria); si ninguna cabe, una nueva.
 */
export function freeTextTrack(p: Project, tipo: TipoTexto, start: number, end: number, preferida = 1, ignoreId?: string): number {
  const libre = (t: number) => !p.layers.some(l => l.type === tipo && l.id !== ignoreId && pistaTexto(l) === t && pisa(l, start, end))
  const n = textTrackCount(p, tipo)
  const pref = Math.min(Math.max(1, preferida), n + 1)
  if (libre(pref)) return pref
  const orden = Array.from({ length: n }, (_, i) => i + 1).sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b)
  for (const t of orden) if (libre(t)) return t
  return n + 1
}
/**
 * Garantiza que ningún subtítulo/gráfico quede encima de otro en la misma pista (se corre tras CADA comando y al soltar un arrastre):
 * recorre las capas por orden de inicio y, si una choca con otra ya colocada en su pista, la pasa a la pista libre más cercana (o a una nueva).
 * Después renumera para que no queden pistas vacías. La pista 1 no se guarda (ausente = 1).
 */
export function acomodarTextos(p: Project) {
  for (const tipo of ['subtitle', 'graphic'] as const) {
    const capas = p.layers.filter(l => l.type === tipo).sort((a, b) => a.start - b.start || pistaTexto(a) - pistaTexto(b))
    const hechas: Layer[] = []
    for (const l of capas) {
      const choca = (t: number) => hechas.some(h => pistaTexto(h) === t && pisa(h, l.start, l.end))
      if (choca(pistaTexto(l))) {
        const max = hechas.reduce((m, h) => Math.max(m, pistaTexto(h)), 1)
        const cand = Array.from({ length: max + 1 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - pistaTexto(l)) - Math.abs(b - pistaTexto(l)) || a - b)
        l.track = cand.find(t => !choca(t)) ?? max + 1
      }
      hechas.push(l)
    }
    const usadas = [...new Set(capas.map(pistaTexto))].sort((a, b) => a - b)
    for (const l of capas) { const t = usadas.indexOf(pistaTexto(l)) + 1; if (t === 1) delete l.track; else l.track = t }
  }
}

/** Número de pistas usadas por un tipo (video o audio). */
export const trackCount = (p: Project, kind: OverlayClip['kind']) => (p.overlays ?? []).reduce((m, o) => (o.kind === kind ? Math.max(m, o.track) : m), 0)

/** Renumera las pistas para que no queden huecos (si una pista se vacía, las demás bajan). El orden relativo se conserva. */
export function compactTracks(p: Project) {
  for (const kind of ['video', 'audio'] as const) {
    const used = [...new Set((p.overlays ?? []).filter(o => o.kind === kind).map(o => o.track))].sort((a, b) => a - b)
    for (const o of p.overlays ?? []) if (o.kind === kind) o.track = used.indexOf(o.track) + 1
  }
}

/**
 * Primera pista (desde `from`) donde cabe [start, end) sin pisar a otro clip del mismo tipo.
 * Si todas están ocupadas devuelve una nueva: así "se abre otra pista" al superponer.
 */
export function freeTrack(p: Project, kind: OverlayClip['kind'], start: number, end: number, from = 1, ignoreId?: string): number {
  for (let t = Math.max(from, 1); ; t++) {
    const busy = (p.overlays ?? []).some(o => o.kind === kind && o.track === t && o.id !== ignoreId && o.start < end - 1e-6 && overlayEnd(o) > start + 1e-6)
    if (!busy) return t
  }
}

/** ¿Qué clip y qué tiempo del archivo fuente corresponden a un tiempo de la línea de tiempo? */
export function locate(p: Project, t: number): { placed: Placed; srcTime: number } | null {
  const l = layout(p)
  if (!l.length) return null
  const md = mainDuration(p)
  if (t > md + 1e-3) return null     // pasado el final de la pista principal (solo siguen los clips superpuestos)
  const tt = Math.min(Math.max(t, 0), md - 1e-4)
  const placed = l.find(x => tt >= x.start && tt < x.end) ?? l[l.length - 1]
  return { placed, srcTime: placed.clip.srcIn + (tt - placed.start) * placed.clip.speed }
}
