import { MIN_DUR, acomodarTextos, clipDur, compactTracks, duration, freeTrack, layout, overlayDur } from './timeline'
import { LIMITS, TRANSITION_DEFAULTS, ZOOM_DEFAULTS } from './fx'
import type { Store } from './store'
import {
  CLIP_COLOR_DEFAULT, CLIP_TRANSFORM_DEFAULT, DEFAULT_TRANSFORM, isTextLayer,
  TRANSITION_KINDS, ZOOM_KINDS,
  type AssetInfo, type Clip, type ClipColor, type ClipTransform, type Layer, type Project, type TextLayer, type Transform, type Transition, type ZoomFx,
} from './types'

/** Capa nueva sin id; el transform puede ser parcial. */
export type NewLayer = (Layer extends infer L ? L extends Layer ? Omit<L, 'id' | 'transform'> & { transform?: Partial<Transform> } : never : never)
export type OverlayPatch = { mascara?: { x: number; y: number; w: number; aspect: number; r: number } | null; transicion?: 'fundido' | 'subir' | '3d' | null; crop?: { l: number; t: number; r: number; b: number } | null; blend?: 'screen' | null; color?: Partial<ClipColor> | null; fundido?: { entrada?: number; salida?: number } | null; start?: number; track?: number; srcIn?: number; srcOut?: number; speed?: number; volume?: number; transform?: Partial<Transform> }
export type LayerPatch = { transform?: Partial<Transform>; [k: string]: unknown }

/**
 * Comandos de alto nivel. La interfaz y Claude (por MCP) usan exactamente estos.
 * Todos los tiempos son segundos. Los de lote reciben tiempos de la línea de tiempo ACTUAL.
 */
export type Cmd =
  | { op: 'import_asset'; asset: AssetInfo }
  | { op: 'add_clip'; asset: string; src_in?: number; src_out?: number }
  | { op: 'add_overlay'; asset: string; start: number; track?: number; src_in?: number; src_out?: number; x?: number; y?: number; scale?: number; volume?: number; blend?: 'screen' }
  | { op: 'clip_to_overlay'; clip: string; start: number; track?: number }
  | { op: 'update_overlay'; id: string; patch: OverlayPatch }
  | { op: 'delete_overlay'; id: string }
  | { op: 'split_overlay'; id: string; at: number }                               // corta un clip superpuesto (video o audio) en `at` (S)
  | { op: 'trim_overlay'; id: string; lado: 'antes' | 'despues'; at: number }     // borra lo anterior (Q) o lo posterior (W) a `at` en un superpuesto
  | { op: 'set_track'; track: string; locked?: boolean; hidden?: boolean; muted?: boolean }
  | { op: 'set_zoom'; clip: string; zoom: ZoomFx | null }
  | { op: 'set_transition'; clip: string; transition: Transition | null }
  | { op: 'set_clip_color'; clip: string; color: Partial<ClipColor> | null }
  | { op: 'set_audio_fx'; on: boolean }
  | { op: 'set_clip_transform'; clip: string; transform: Partial<ClipTransform> | null }
  | { op: 'set_music'; asset: string; src_in?: number; volume?: number; fade_out?: number }
  | { op: 'clear_music' }
  | { op: 'set_format'; width: number; height: number; fps?: number }
  | { op: 'split'; at: number }
  | { op: 'delete_range'; from: number; to: number }
  | { op: 'delete_ranges'; ranges: [number, number][] }
  | { op: 'delete_clip'; id: string }
  | { op: 'speed'; clip: string; value: number }
  | { op: 'speed_all'; value: number }
  | { op: 'volume'; clip: string; value: number }
  | { op: 'move_clip'; id: string; to_index: number }
  | { op: 'trim'; id: string; edge: 'in' | 'out'; src_time: number }
  | { op: 'add_text'; type: 'subtitle' | 'graphic'; start: number; end: number; text: string; x?: number; y?: number; size?: number; color?: string; track?: number }
  | { op: 'add_layer'; layer: NewLayer }
  | { op: 'update_layer'; id: string; patch: LayerPatch }
  | { op: 'delete_layer'; id: string }

const f2 = (n: number) => n.toFixed(2)
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)

/** Ejecuta un comando como UNA entrada de historial. Devuelve un resumen de una línea. */
/** Gancho opcional: se llama con cada comando ya aplicado (lo usa el editor para APRENDER del estilo del usuario; sin él no pasa nada). */
let alComando: ((cmd: Cmd) => void) | null = null
export const setAlComando = (fn: ((cmd: Cmd) => void) | null) => { alComando = fn }

export function exec(store: Store, cmd: Cmd): string {
  let msg = 'sin cambios'
  store.mutate(p => { msg = apply(store, p, cmd); acomodarTextos(p) })
  alComando?.(cmd)
  return msg
}

/** Ejecuta varios comandos como UNA sola entrada de historial. */
export function execBatch(store: Store, cmds: Cmd[]): string[] {
  const out: string[] = []
  store.mutate(p => { for (const c of cmds) out.push(apply(store, p, c)); acomodarTextos(p) })     // al final del lote: los choques intermedios no cuentan
  if (alComando) for (const c of cmds) alComando(c)
  return out
}

/** Mueve en el tiempo todo lo que no es el clip principal tras un recorte/borrado: capas, tiempos de las palabras del karaoke (props.palabras) y superpuestos/sonidos. */
function rippleTodo(p: Project, mover: (t: number) => number) {
  const conPalabras = (l: Layer): Layer => {
    const pr = (l as { props?: Record<string, string> }).props
    if (!pr?.palabras) return l
    try { return ({ ...l, props: { ...pr, palabras: JSON.stringify((JSON.parse(pr.palabras) as [string, number, number][]).map(([w, a, b]) => [w, +mover(a).toFixed(3), +mover(b).toFixed(3)])) } } as unknown as Layer) } catch { return l }
  }
  p.layers = p.layers.flatMap(l => {
    const s = mover(l.start), e = mover(l.end)
    return e - s < 0.1 ? [] : [conPalabras({ ...l, start: s, end: e })]
  })
  if (p.overlays) p.overlays = p.overlays.map(o => ({ ...o, start: +mover(o.start).toFixed(3) }))
}

/**
 * Un subtítulo karaoke se dibuja con `props.palabras` (cada palabra con su tiempo), no con `text`. Al cambiar `text` hay que rehacer esa lista:
 * las palabras que no cambiaron conservan su tiempo (se emparejan por texto en orden) y las nuevas se reparten en el hueco que dejan.
 */
export function sincronizarPalabras(l: Layer) {
  const pr = (l as { props?: Record<string, string> }).props
  if (l.type !== 'subtitle' || !pr?.palabras) return
  let old: [string, number, number][]
  try { old = JSON.parse(pr.palabras) } catch { return }
  const nuevas = l.text.split(/\s+/).filter(Boolean)
  if (!old.length || !nuevas.length) return
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const n = old.length, m = nuevas.length
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))      // subsecuencia común más larga
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = norm(old[i][0]) === norm(nuevas[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const t0 = new Array<number | null>(m).fill(null), t1 = new Array<number | null>(m).fill(null)
  for (let i = 0, j = 0; i < n && j < m;) {
    if (norm(old[i][0]) === norm(nuevas[j])) { t0[j] = old[i][1]; t1[j] = old[i][2]; i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++
  }
  const ini = old[0][1], fin = old[n - 1][2]
  for (let j = 0; j < m;) {
    if (t0[j] !== null) { j++; continue }
    let k = j; while (k < m && t0[k] === null) k++
    const a = j > 0 ? (t1[j - 1] as number) : ini, b = k < m ? (t0[k] as number) : fin
    const pesos = nuevas.slice(j, k).map(w => Math.max(2, norm(w).length) + 1), tot = pesos.reduce((x, y) => x + y, 0)
    let x = a
    for (let q = j; q < k; q++) { t0[q] = x; x += (Math.max(b - a, 0.1 * (k - j)) * pesos[q - j]) / tot; t1[q] = x }
    j = k
  }
  pr.palabras = JSON.stringify(nuevas.map((w, q) => [w, +(t0[q] as number).toFixed(3), +(t1[q] as number).toFixed(3)]))
}

function apply(store: Store, p: Project, cmd: Cmd): string {
  switch (cmd.op) {
    case 'import_asset': {
      if (p.assets.some(a => a.id === cmd.asset.id)) return `asset ${cmd.asset.id} ya existe`
      p.assets.push(cmd.asset)
      return `asset ${cmd.asset.id} importado (${cmd.asset.name})`
    }
    case 'add_clip': {
      const a = p.assets.find(x => x.id === cmd.asset)
      if (!a) return 'asset no encontrado'
      const srcIn = clamp(cmd.src_in ?? 0, 0, a.duration)
      const srcOut = clamp(cmd.src_out ?? a.duration, srcIn, a.duration)
      if (srcOut - srcIn < MIN_DUR) return 'tramo demasiado corto'
      const c: Clip = { id: store.newId('c'), assetId: a.id, srcIn, srcOut, speed: 1, volume: 1 }
      p.clips.push(c)
      return `${c.id} añadido (${a.name} ${f2(srcIn)}–${f2(srcOut)})`
    }
    case 'add_overlay': {
      const a = p.assets.find(x => x.id === cmd.asset)
      if (!a) return 'asset no encontrado'
      const kind: 'audio' | 'video' = a.kind === 'audio' ? 'audio' : 'video'
      const srcIn = clamp(cmd.src_in ?? 0, 0, a.duration)
      const srcOut = clamp(cmd.src_out ?? (a.kind === 'image' ? srcIn + 4 : a.duration), srcIn, a.duration)      // una imagen dura 4 s por defecto (se estira en la línea de tiempo)
      if (srcOut - srcIn < MIN_DUR) return 'tramo demasiado corto'
      const start = Math.max(cmd.start, 0)
      const track = freeTrack(p, kind, start, start + (srcOut - srcIn), cmd.track ?? 1)
      const o = { id: store.newId('o'), assetId: a.id, kind, track, start, srcIn, srcOut, speed: 1, volume: clamp(cmd.volume ?? 1, 0, 4),
        transform: { ...DEFAULT_TRANSFORM, x: cmd.x ?? 0.5, y: cmd.y ?? 0.5, scale: cmd.scale ?? (kind === 'video' ? 0.5 : 1) }, ...(cmd.blend && kind === 'video' ? { blend: cmd.blend } : {}) }
      ;(p.overlays ??= []).push(o)
      compactTracks(p)
      return `${o.id} ${kind} en pista ${track} desde ${f2(start)}s (${a.name})`
    }
    case 'clip_to_overlay': {
      // Arrastrar un clip de la pista principal hacia arriba: sale de la pista magnética (que se cierra) y pasa a una pista superpuesta
      const i = p.clips.findIndex(c => c.id === cmd.clip)
      if (i < 0) return 'clip no encontrado'
      const [c] = p.clips.splice(i, 1)
      const start = Math.max(0, cmd.start), len = clipDur(c)
      const o = { id: store.newId('o'), assetId: c.assetId, kind: 'video' as const, track: freeTrack(p, 'video', start, start + len, cmd.track ?? 1),
        start, srcIn: c.srcIn, srcOut: c.srcOut, speed: c.speed, volume: c.volume, transform: { ...DEFAULT_TRANSFORM, scale: 1 } }
      ;(p.overlays ??= []).push(o)
      compactTracks(p)
      store.selection = { type: 'overlay', id: o.id }
      return `${c.id} pasó a ${o.id} (pista de video ${o.track}) desde ${f2(start)}s`
    }
    case 'update_overlay': {
      const o = p.overlays?.find(x => x.id === cmd.id)
      if (!o) return 'clip superpuesto no encontrado'
      const { transform, blend, crop, transicion, mascara, color, fundido, ...rest } = cmd.patch
      if (fundido !== undefined) {
        const f = { ...o.fundido, ...fundido }, d = overlayDur(o) / 2
        const ent = clamp(f.entrada ?? 0, 0, d), sal = clamp(f.salida ?? 0, 0, d)
        if (!fundido || (!ent && !sal)) delete o.fundido; else o.fundido = { ...(ent ? { entrada: ent } : {}), ...(sal ? { salida: sal } : {}) }
      }
      if (color !== undefined) {
        if (!color) delete o.color
        else {
          const k = { ...CLIP_COLOR_DEFAULT, ...o.color, ...color }
          k.brillo = clamp(k.brillo, 0.5, 1.8); k.contraste = clamp(k.contraste, 0.6, 1.6); k.saturacion = clamp(k.saturacion, 0, 2)
          if (k.brillo === 1 && k.contraste === 1 && k.saturacion === 1) delete o.color; else o.color = k
        }
      }
      if (mascara !== undefined) { if (mascara) o.mascara = { x: clamp(mascara.x, 0, 1), y: clamp(mascara.y, 0, 1), w: clamp(mascara.w, 0.05, 1), aspect: clamp(mascara.aspect, 0.2, 5), r: clamp(mascara.r, 0, 0.5) }; else delete o.mascara }
      if (transicion !== undefined) { if (transicion) o.transicion = transicion; else delete o.transicion }
      const a = p.assets.find(x => x.id === o.assetId)
      Object.assign(o, rest)
      if (crop !== undefined) { if (crop) { const c = (v: number) => clamp(v, 0, 0.9); let l = c(crop.l), r = c(crop.r), t = c(crop.t), b = c(crop.b); if (l + r > 0.92) { const k = 0.92 / (l + r); l *= k; r *= k } if (t + b > 0.92) { const k = 0.92 / (t + b); t *= k; b *= k }; o.crop = { l, t, r, b } } else delete o.crop }
      if (blend !== undefined) { if (blend) o.blend = blend; else delete o.blend }
      if (a) { o.srcIn = clamp(o.srcIn, 0, a.duration); o.srcOut = clamp(o.srcOut, o.srcIn + MIN_DUR * o.speed, a.duration) }
      o.start = Math.max(o.start, 0); o.speed = clamp(o.speed, 0.1, 8); o.volume = clamp(o.volume, 0, 4)
      if (transform) o.transform = { ...o.transform, ...transform }
      if (cmd.patch.start !== undefined || cmd.patch.track !== undefined || cmd.patch.srcIn !== undefined || cmd.patch.srcOut !== undefined || cmd.patch.speed !== undefined)
        o.track = freeTrack(p, o.kind, o.start, o.start + overlayDur(o), cmd.patch.track ?? o.track, o.id)   // si pisa a otro, se abre otra pista
      compactTracks(p)
      return `${o.id} actualizado (pista ${o.track}, ${f2(o.start)}s)`
    }
    case 'split_overlay': case 'trim_overlay': {
      const o = p.overlays?.find(x => x.id === cmd.id)
      if (!o) return 'clip superpuesto no encontrado'
      const fin = o.start + overlayDur(o)
      if (cmd.at <= o.start + MIN_DUR || cmd.at >= fin - MIN_DUR) return 'el cabezal no está dentro del clip'
      const cut = o.srcIn + (cmd.at - o.start) * o.speed        // tiempo del archivo fuente en el punto de corte
      if (cmd.op === 'trim_overlay') {
        if (cmd.lado === 'antes') { o.srcIn = cut; o.start = cmd.at } else o.srcOut = cut      // sin cerrar el hueco: los superpuestos son libres en el tiempo
        return `${o.id} recortado ${cmd.lado === 'antes' ? 'al inicio' : 'al final'} en ${f2(cmd.at)}s`
      }
      const b = { ...structuredClone(o), id: store.newId('o'), start: cmd.at, srcIn: cut }
      o.srcOut = cut
      if (o.fundido) { if (o.fundido.salida) { b.fundido = { salida: o.fundido.salida }; o.fundido = o.fundido.entrada ? { entrada: o.fundido.entrada } : undefined } else delete b.fundido; if (!o.fundido) delete o.fundido }
      p.overlays!.splice(p.overlays!.indexOf(o) + 1, 0, b)
      return `${o.id} cortado en ${f2(cmd.at)}s → ${b.id}`
    }
    case 'delete_overlay': {
      const n = p.overlays?.length ?? 0
      p.overlays = (p.overlays ?? []).filter(x => x.id !== cmd.id)
      compactTracks(p)
      if (store.selection?.id === cmd.id) store.selection = null
      return n === p.overlays.length ? 'clip superpuesto no encontrado' : `${cmd.id} eliminado`
    }
    case 'set_track': {
      const t = (p.tracks ??= {}), s = (t[cmd.track] ??= {})
      if (cmd.locked !== undefined) s.locked = cmd.locked || undefined
      if (cmd.hidden !== undefined) s.hidden = cmd.hidden || undefined
      if (cmd.muted !== undefined) s.muted = cmd.muted || undefined
      if (!s.locked && !s.hidden && !s.muted) delete t[cmd.track]
      return `pista ${cmd.track}: ${[s.locked && 'bloqueada', s.hidden && 'oculta', s.muted && 'silenciada'].filter(Boolean).join(', ') || 'normal'}`
    }
    case 'set_zoom': {
      const c = p.clips.find(x => x.id === cmd.clip)
      if (!c) return 'clip no encontrado'
      if (!cmd.zoom) { delete c.zoom; return `${c.id} sin zoom` }
      if (!ZOOM_KINDS.includes(cmd.zoom.kind)) return `zoom desconocido (${ZOOM_KINDS.join(', ')})`
      const d = ZOOM_DEFAULTS[cmd.zoom.kind]
      c.zoom = { kind: cmd.zoom.kind, amount: clamp(cmd.zoom.amount ?? d.amount, ...LIMITS.zoomAmount),
        ...(cmd.zoom.kind === 'punch' ? { duration: clamp(cmd.zoom.duration ?? d.duration ?? 0.35, ...LIMITS.zoomDuration) } : {}) }
      return `${c.id} zoom ${c.zoom.kind} ${Math.round(c.zoom.amount * 100)}%`
    }
    case 'set_clip_color': {
      const c = p.clips.find(x => x.id === cmd.clip)
      if (!c) return 'clip no encontrado'
      if (!cmd.color) { delete c.color; return `clip ${c.id}: sin corrección de color` }
      const k = { ...CLIP_COLOR_DEFAULT, ...c.color, ...cmd.color }
      k.brillo = clamp(k.brillo, 0.5, 1.8); k.contraste = clamp(k.contraste, 0.6, 1.6); k.saturacion = clamp(k.saturacion, 0, 2)
      if (k.brillo === 1 && k.contraste === 1 && k.saturacion === 1) delete c.color; else c.color = k
      return `clip ${c.id}: brillo ${f2(k.brillo)} contraste ${f2(k.contraste)} saturación ${f2(k.saturacion)}`
    }
    case 'set_audio_fx': {
      p.mejoras = { ...p.mejoras, audio: cmd.on }
      return `voz limpia y pareja ${cmd.on ? 'activada' : 'desactivada'}`
    }
    case 'set_clip_transform': {
      const c = p.clips.find(x => x.id === cmd.clip)
      if (!c) return 'clip no encontrado'
      if (!cmd.transform) { delete c.transform; return `clip ${c.id}: video ajustado y centrado` }
      const t = { ...CLIP_TRANSFORM_DEFAULT, ...c.transform, ...cmd.transform }
      t.x = clamp(t.x, -1, 2); t.y = clamp(t.y, -1, 2); t.scale = clamp(t.scale, 0.05, 8); t.rotation = ((t.rotation + 180) % 360 + 360) % 360 - 180
      if (t.x === 0.5 && t.y === 0.5 && t.scale === 1 && t.rotation === 0) delete c.transform; else c.transform = t
      return `clip ${c.id}: video x${f2(t.x)} y${f2(t.y)} tamaño ${f2(t.scale)} giro ${f2(t.rotation)}°`
    }
    case 'set_transition': {
      // `clip` es el clip que ENTRA; la transición también es la salida del anterior
      const i = p.clips.findIndex(x => x.id === cmd.clip)
      if (i < 0) return 'clip no encontrado'
      if (i === 0) return 'el primer clip no tiene corte antes'
      const c = p.clips[i]
      if (!cmd.transition) { delete c.transition; return `corte ${p.clips[i - 1].id}|${c.id} sin transición` }
      if (!TRANSITION_KINDS.includes(cmd.transition.kind)) return `transición desconocida (${TRANSITION_KINDS.join(', ')})`
      const d = TRANSITION_DEFAULTS[cmd.transition.kind]
      c.transition = { kind: cmd.transition.kind, duration: clamp(cmd.transition.duration ?? d.duration, ...LIMITS.trDuration),
        intensity: clamp(cmd.transition.intensity ?? d.intensity, ...LIMITS.trIntensity), ...(cmd.transition.kind === 'slide' ? { dir: cmd.transition.dir === -1 ? -1 as const : 1 as const } : {}) }
      return `corte ${p.clips[i - 1].id}|${c.id}: ${c.transition.kind} ${c.transition.duration}s`
    }
    case 'set_music': {
      const a = p.assets.find(x => x.id === cmd.asset)
      if (!a) return 'asset no encontrado'
      p.music = { assetId: a.id, srcIn: clamp(cmd.src_in ?? 0, 0, a.duration), volume: clamp(cmd.volume ?? 1, 0, 4), fadeOut: clamp(cmd.fade_out ?? 0.9, 0, 10) }
      return `música ${a.name} desde ${f2(p.music.srcIn)}s`
    }
    case 'clear_music': { delete p.music; return 'música quitada' }
    case 'set_format': {
      p.format = { width: Math.round(clamp(cmd.width, 16, 8192)), height: Math.round(clamp(cmd.height, 16, 8192)), fps: cmd.fps ?? p.format.fps }
      return `formato ${p.format.width}x${p.format.height}`
    }
    case 'split': {
      const hit = layout(p).find(x => cmd.at > x.start + MIN_DUR && cmd.at < x.end - MIN_DUR)
      if (!hit) return 'no se puede cortar ahí (borde del clip)'
      const srcAt = hit.clip.srcIn + (cmd.at - hit.start) * hit.clip.speed
      const right: Clip = { ...hit.clip, id: store.newId('c'), srcIn: srcAt }
      delete right.zoom; delete right.transition     // el zoom y la transición de entrada se quedan en la mitad izquierda
      hit.clip.srcOut = srcAt
      p.clips.splice(p.clips.indexOf(hit.clip) + 1, 0, right)
      return `corte en ${f2(cmd.at)}s → ${hit.clip.id} | ${right.id}`
    }
    case 'delete_range': {
      const { from, to } = cmd
      if (to - from < 1e-3) return 'rango vacío'
      const out: Clip[] = []
      for (const { clip, start, end } of layout(p)) {
        const pieces: [number, number][] = []
        if (from > start) pieces.push([start, Math.min(end, from)])
        if (to < end) pieces.push([Math.max(start, to), end])
        pieces.forEach(([a, b], i) => {
          if (b - a < MIN_DUR) return
          const piece: Clip = {
            ...clip,
            id: i === 0 ? clip.id : store.newId('c'),
            srcIn: clip.srcIn + (a - start) * clip.speed,
            srcOut: clip.srcIn + (b - start) * clip.speed,
          }
          if (i > 0) { delete piece.zoom; delete piece.transition }     // las piezas nuevas no repiten zoom ni transición
          out.push(piece)
        })
      }
      p.clips = out
      // Las capas se desplazan con el ripple.
      const d = to - from
      rippleTodo(p, (t: number) => (t <= from ? t : t >= to ? t - d : from))
      return `borrado ${f2(from)}–${f2(to)}s (ripple, ${f2(d)}s)`
    }
    case 'delete_ranges': {
      // De atrás hacia adelante para que el ripple no desplace los rangos pendientes.
      const rs = [...cmd.ranges].sort((a, b) => b[0] - a[0])
      let removed = 0
      for (const [from, to] of rs) { apply(store, p, { op: 'delete_range', from, to }); removed += to - from }
      return `${rs.length} cortes, ${f2(removed)}s eliminados`
    }
    case 'delete_clip': {
      const placed = layout(p).find(x => x.clip.id === cmd.id)
      if (!placed) return 'clip no encontrado'
      return apply(store, p, { op: 'delete_range', from: placed.start, to: placed.end })
    }
    case 'speed': {
      const c = p.clips.find(x => x.id === cmd.clip)
      if (!c) return 'clip no encontrado'
      c.speed = clamp(cmd.value, 0.1, 8)
      return `${c.id} velocidad x${c.speed}`
    }
    case 'speed_all': {
      const v = clamp(cmd.value, 0.1, 8)
      p.clips.forEach(c => { c.speed = v })
      return `${p.clips.length} clips a x${v}`
    }
    case 'volume': {
      const c = p.clips.find(x => x.id === cmd.clip)
      if (!c) return 'clip no encontrado'
      c.volume = clamp(cmd.value, 0, 4)
      return `${c.id} volumen ${c.volume}`
    }
    case 'move_clip': {
      const i = p.clips.findIndex(x => x.id === cmd.id)
      if (i < 0) return 'clip no encontrado'
      const [c] = p.clips.splice(i, 1)
      p.clips.splice(clamp(cmd.to_index, 0, p.clips.length), 0, c)
      return `${c.id} movido a posición ${p.clips.indexOf(c)}`
    }
    case 'trim': {
      const c = p.clips.find(x => x.id === cmd.id)
      if (!c) return 'clip no encontrado'
      const total = p.assets.find(a => a.id === c.assetId)?.duration ?? Infinity
      const minSrc = MIN_DUR * c.speed
      const antes = layout(p).find(x => x.clip.id === c.id)
      if (cmd.edge === 'in') c.srcIn = Math.min(Math.max(cmd.src_time, 0), c.srcOut - minSrc)
      else c.srcOut = Math.max(Math.min(cmd.src_time, total), c.srcIn + minSrc)
      if (antes) {                                       // lo que viene después (capas, palabras del karaoke, sonidos) se corre con el borde, como en delete_range
        const dd = (c.srcOut - c.srcIn) / c.speed - (antes.end - antes.start), fin = antes.end
        if (Math.abs(dd) > 1e-4) rippleTodo(p, dd < 0 ? (t: number) => (t <= fin + dd ? t : t >= fin ? t + dd : fin + dd) : (t: number) => (t <= fin ? t : t + dd))
      }
      return `${c.id} recortado (${cmd.edge}) → ${f2(c.srcIn)}–${f2(c.srcOut)}`
    }
    case 'add_text': {
      const sub = cmd.type === 'subtitle'
      const layer = {
        id: store.newId(sub ? 's' : 'g'),
        type: cmd.type, start: cmd.start, end: cmd.end, text: cmd.text,
        ...(sub ? {} : { template: 'lowerthird' }),
        size: cmd.size ?? (sub ? 54 : 44),
        color: cmd.color ?? (sub ? '#ffffff' : '#ff3d6e'),
        transform: { ...DEFAULT_TRANSFORM, x: cmd.x ?? (sub ? 0.5 : 0.28), y: cmd.y ?? (sub ? 0.85 : 0.18) },
        ...(cmd.track && cmd.track > 1 ? { track: cmd.track } : {}),       // si choca con otro, acomodarTextos lo pasa a una pista libre
      } as TextLayer
      p.layers.push(layer)
      store.selection = { type: 'layer', id: layer.id }
      return `${layer.id} añadido ${f2(layer.start)}–${f2(layer.end)}s "${layer.text}"`
    }
    case 'add_layer': {
      const l = { ...cmd.layer, id: store.newId('l'), transform: { ...DEFAULT_TRANSFORM, ...cmd.layer.transform } } as Layer
      // un `fondo` (velo o pantalla de gráfico) SIEMPRE va debajo de los demás gráficos: el orden de la lista es el orden de dibujo, y un velo dibujado después del texto lo oscurece
      if (l.type === 'graphic' && l.template === 'fondo') p.layers.unshift(l); else p.layers.push(l)
      return `${l.id} (${l.type}) añadido ${f2(l.start)}–${f2(l.end)}s`
    }
    case 'update_layer': {
      const l = p.layers.find(x => x.id === cmd.id)
      if (!l) return 'capa no encontrada'
      const { transform, ...rest } = cmd.patch
      Object.assign(l, rest)
      if ('text' in rest) sincronizarPalabras(l)
      if (transform) l.transform = { ...l.transform, ...transform }
      return `${l.id} actualizado`
    }
    case 'delete_layer': {
      const n = p.layers.length
      p.layers = p.layers.filter(x => x.id !== cmd.id)
      if (store.selection?.id === cmd.id) store.selection = null
      return n === p.layers.length ? 'capa no encontrada' : `${cmd.id} eliminada`
    }
  }
}

const tc = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`

/**
 * Resumen compacto del proyecto (lo que lee Claude). Los clips consecutivos del mismo
 * archivo con la misma velocidad se agrupan para que el tamaño no crezca con cada corte.
 */
export function describe(store: Store, corto = false): string {
  const p = store.project
  const placed = layout(p)
  const lines = [`"${p.name}" ${p.format.width}x${p.format.height}@${p.format.fps} · ${tc(duration(p))} · ${p.clips.length} clips · ${p.layers.length} capas${p.overlays?.length ? ` · ${p.overlays.length} superpuestos` : ''}${p.music ? ` · música ${store.asset(p.music.assetId)?.name ?? p.music.assetId} desde ${f2(p.music.srcIn)}s` : ''}`]
  let i = 0
  while (i < placed.length) {
    let j = i
    while (j + 1 < placed.length
      && placed[j + 1].clip.assetId === placed[i].clip.assetId
      && placed[j + 1].clip.speed === placed[i].clip.speed
      && placed[j + 1].clip.volume === placed[i].clip.volume
      && JSON.stringify([placed[j + 1].clip.zoom, placed[j + 1].clip.transition]) === JSON.stringify([placed[i].clip.zoom, placed[i].clip.transition])) j++
    const a = store.asset(placed[i].clip.assetId)
    const first = placed[i], last = placed[j]
    const n = j - i + 1
    lines.push(n === 1
      ? `${first.clip.id} [${tc(first.start)}–${tc(first.end)}] ${a?.name ?? first.clip.assetId} src ${f2(first.clip.srcIn)}–${f2(first.clip.srcOut)} x${first.clip.speed} vol${first.clip.volume}${first.clip.zoom ? ` zoom:${first.clip.zoom.kind}(${first.clip.zoom.amount})` : ''}${first.clip.transition ? ` entra:${first.clip.transition.kind}(${first.clip.transition.duration}s)` : ''}`
      : `${first.clip.id}…${last.clip.id} [${tc(first.start)}–${tc(last.end)}] ${n} clips ${a?.name ?? first.clip.assetId} x${first.clip.speed} vol${first.clip.volume}`)
    i = j + 1
  }
  if (corto) {     // resumen: solo cuántas capas y superpuestos hay, sin una línea por cada uno
    const porTipo = new Map<string, number>()
    for (const l of p.layers) { const k = l.type === 'graphic' || l.type === 'subtitle' ? `${l.type}:${l.template ?? 'texto'}` : l.type; porTipo.set(k, (porTipo.get(k) ?? 0) + 1) }
    if (porTipo.size) lines.push('capas: ' + [...porTipo].map(([k, n]) => `${k}×${n}`).join(' · '))
    const ov = p.overlays ?? []
    if (ov.length) lines.push(`superpuestos: ${ov.map(o => `${o.id}[${tc(o.start)}–${tc(o.start + overlayDur(o))}]`).join(' ')}`)
    return lines.join('\n')
  }
  for (const o of [...(p.overlays ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.track - b.track || a.start - b.start))
    lines.push(`${o.id} ${o.kind === 'video' ? 'video' : 'audio'} pista ${o.track} [${tc(o.start)}–${tc(o.start + overlayDur(o))}] ${store.asset(o.assetId)?.name ?? o.assetId} src ${f2(o.srcIn)}–${f2(o.srcOut)} vol${o.volume}${o.kind === 'video' ? ` @(${f2(o.transform.x)},${f2(o.transform.y)}) ×${f2(o.transform.scale)}` : ''}`)
  for (const l of [...p.layers].sort((a, b) => a.start - b.start)) {
    const t = l.transform
    lines.push(`${l.id} ${l.type} [${tc(l.start)}–${tc(l.end)}] ${isTextLayer(l) ? `"${l.text}" ` : ''}@(${f2(t.x)},${f2(t.y)})`)
  }
  return lines.join('\n')
}
