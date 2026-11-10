/**
 * Exportar a MP4: renderiza la edición actual (.gojaguar) con ffmpeg.
 * Incluye: pista principal con zoom/transiciones por clip, videos superpuestos (posición, tamaño, opacidad, esquinas),
 * audio de los clips, pistas de audio extra y la música. Las fórmulas de movimiento son las mismas de
 * packages/core/src/fx.ts (lo que se ve en el editor es lo que sale en el archivo).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { renderRotulos } from './rotulos'
import { nivelarVoz } from './voz'
import { CARD3D, CLIP_COLOR_DEFAULT, ladoCard, layout, mainDuration, overlayDur, duration, parseProject, type AssetInfo, type Clip, type ClipColor, type Project, type Transition } from '@gojaguar/core'

export interface ExportOpts { resolucion: 'original' | '720' | '480'; calidad: 'rapida' | 'buena' | 'maxima'; nombre?: string }
export interface ExportJob {
  id: string; slug: string; status: 'running' | 'done' | 'error' | 'cancelado'; pct: number
  detail?: string; error?: string; file?: string; url?: string; size?: number; opts: ExportOpts; cancelada?: boolean
  /** Segundos que tomó cada etapa (para ver qué hace lenta una exportación). */
  tiempos?: Record<string, number>
}

const jobs = new Map<string, ExportJob>()
const procs = new Map<string, ChildProcess>()
export const getExport = (id: string) => jobs.get(id)
export const activeExport = (slug: string) => [...jobs.values()].find(j => j.slug === slug && j.status === 'running')

const QUALITY: Record<ExportOpts['calidad'], string[]> = {
  rapida: ['-preset', 'veryfast', '-crf', '23'],
  buena: ['-preset', 'medium', '-crf', '19'],
  maxima: ['-preset', 'slow', '-crf', '16'],
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const atempoChain = (v: number) => { const f: number[] = []; let x = v; while (x > 2) { f.push(2); x /= 2 } while (x < 0.5) { f.push(0.5); x /= 0.5 } f.push(x); return f.map(n => `atempo=${n.toFixed(4)}`).join(',') }
const num = (n: number) => String(Math.round(n * 1e4) / 1e4)

function probeAudio(file: string): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])
    let out = ''; p.stdout.on('data', d => { out += d }); p.on('error', () => resolve(false)); p.on('close', () => resolve(out.trim() === 'audio'))
  })
}

const fileOk = (f: string) => fsp.stat(f).then(s => s.isFile(), () => false)
const toPath = (root: string, url: string) => path.join(root, decodeURIComponent(url.replace(/^api\/files\//, '')))
/** Dónde queda el audio ya procesado ("voz limpia y pareja") de un video: junto a su copia liviana, `<video>.voz2.m4a`. */
export const vozPath = (root: string, a: AssetInfo) => toPath(root, a.proxy).replace(/\.proxy\.mp4$/, '.voz2.m4a')

/**
 * Crea (si falta o quedó viejo) el audio procesado de cada video: quita el ruido y nivela la voz (ver voz.ts).
 * Se hace sobre el archivo ORIGINAL completo (no sobre un tramo) para que el filtro adaptativo se comporte igual en la vista previa y en la exportación:
 * las dos usan este mismo archivo.
 */
export async function asegurarVoz(assets: AssetInfo[], root: string, onPct: (p: number) => void = () => {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const vids = assets.filter(a => a.kind !== 'audio' && a.kind !== 'image')
  for (const [i, a] of vids.entries()) {
    const dst = vozPath(root, a)
    const cand = [a.original, toPath(root, a.proxy)]
    let src = ''; for (const f of cand) if (f && path.isAbsolute(f) && await fileOk(f)) { src = f; break }
    if (!src || !(await probeAudio(src))) { onPct((i + 1) / vids.length); continue }
    const fresh = await fileOk(dst) && (await fsp.stat(dst)).mtimeMs > (await fsp.stat(src)).mtimeMs
    if (!fresh) {
      const tmp = dst + '.part.m4a'
      try { await nivelarVoz(src, tmp) } catch (err) { await fsp.rm(tmp, { force: true }); throw new Error('No pude limpiar el audio de "' + a.name + '": ' + (err as Error).message) }
      await fsp.rename(tmp, dst)
    }
    out[a.id] = a.proxy.replace(/\.proxy\.mp4$/, '.voz2.m4a')
    onPct((i + 1) / vids.length)
  }
  return out
}

/** Dónde queda el recorte (máscara de la persona) de un video: junto a su copia liviana, `<video>.recorte.mp4` (ver scripts/recortar-persona.py). */
export const recortePath = (root: string, a: AssetInfo) => toPath(root, a.proxy).replace(/\.proxy\.mp4$/, '.recorte.mp4')

/** Filtro de color de un clip como cadena de ffmpeg: brillo → contraste → saturación, la misma fórmula que el filtro del lienzo en la vista previa. */
export function colorChain(k: ClipColor | undefined): string {
  if (!k) return ''
  const c = { ...CLIP_COLOR_DEFAULT, ...k }
  if (c.brillo === 1 && c.contraste === 1 && c.saturacion === 1) return ''
  const e = `clip((clip(val/maxval*${num(c.brillo)},0,1)-0.5)*${num(c.contraste)}+0.5,0,1)*maxval`
  const s = c.saturacion, r = (n: number) => num(n)
  const mix = `rr=${r(0.213 + 0.787 * s)}:rg=${r(0.715 - 0.715 * s)}:rb=${r(0.072 - 0.072 * s)}:gr=${r(0.213 - 0.213 * s)}:gg=${r(0.715 + 0.285 * s)}:gb=${r(0.072 - 0.072 * s)}:br=${r(0.213 - 0.213 * s)}:bg=${r(0.715 - 0.715 * s)}:bb=${r(0.072 + 0.928 * s)}`
  return `,format=gbrp,lutrgb=r='${e}':g='${e}':b='${e}',colorchannelmixer=${mix},format=yuv420p`
}

/**
 * Zoom + transiciones de un clip como expresiones de zoompan/eq. Misma fórmula que fxAt del core (packages/core/src/fx.ts):
 * la transición del corte se reparte mitad en la salida del clip anterior y mitad en la entrada de este.
 */
function fxExpr(clip: Clip, next: Clip | undefined, D: number, fps: number) {
  const t = `on/${fps}`, tn = `n/${fps}`        // zoompan cuenta fotogramas con "on"; eq con "n"
  const ease = (u: string) => `pow(max(0,1-(${u})),2)`
  const zs: string[] = [], ss: string[] = [], sy: string[] = [], fs: string[] = []
  const zm = clip.zoom
  if (zm) {
    if (zm.kind === 'temblor') {
      // mismas fórmulas que ruido()/fxAt del core
      const n = (k: number) => `(sin(2*PI*17*(${t})+${num(k)})+0.7*sin(2*PI*29*(${t})+${num(1.3 + 1.7 * k)})+0.5*sin(2*PI*43*(${t})+${num(2.1 + 0.6 * k)}))/2.2`
      const env = `min(1,max(0,min((${t})/0.15,(${num(D)}-(${t}))/0.15)))`
      zs.push(`${num(zm.amount * 0.5)}`); ss.push(`0.85*${env}*(${n(0)})`); sy.push(`0.85*${env}*(${n(2.4)})`)
    } else if (zm.kind === 'glitch') {
      const gd = num(zm.duration ?? 0.4), env = `max(0,1-(${t})/${gd})`, n = (k: number) => `(sin(2*PI*17*1.9*(${t})+${num(k)})+0.7*sin(2*PI*29*1.9*(${t})+${num(1.3 + 1.7 * k)})+0.5*sin(2*PI*43*1.9*(${t})+${num(2.1 + 0.6 * k)}))/2.2`
      zs.push(`0.06*${env}`); ss.push(`0.9*${env}*(${n(0.5)})`); sy.push(`0.35*${env}*(${n(3.1)})`)
    } else if (zm.kind === 'push') zs.push(`${num(zm.amount)}*${t}/${num(D)}`)
    else if (zm.kind === 'pull') zs.push(`${num(zm.amount)}*(1-${t}/${num(D)})`)
    else zs.push(`${num(zm.amount)}*${ease(`${t}/${num(zm.duration ?? 0.35)}`)}+0.05*${t}/${num(D)}`)
  }
  const side = (tr: Transition | undefined, kind: 'in' | 'out') => {
    if (!tr) return
    const h = num(tr.duration / 2), k = num(tr.intensity)
    const e = (tv: string) => ease(kind === 'in' ? `${tv}/${h}` : `(${num(D)}-${tv})/${h}`)
    if (tr.kind === 'slide') { zs.push(`${num(0.22 * tr.intensity)}*${e(t)}`); ss.push(`${kind === 'in' ? 1 : -1}*${tr.dir ?? 1}*${e(t)}`) }
    else if (tr.kind === 'flash') fs.push(`${num(0.9 * tr.intensity)}*${e(tn)}`)
    else fs.push(`-${k}*${e(tn)}`)
  }
  side(clip.transition, 'in'); side(next?.transition, 'out')
  return {
    z: zs.length ? `1+${zs.join('+')}` : '1',
    x: 'iw/2-(iw/zoom/2)' + (ss.length ? `+(iw-iw/zoom)/2*(${ss.join('+')})` : ''),
    glitch: zm && zm.kind === 'glitch' ? { amt: zm.amount, dur: zm.duration ?? 0.4 } : null,
    y: 'ih/2-(ih/zoom/2)' + (sy.length ? `+(ih-ih/zoom)/2*(${sy.join('+')})` : ''),
    flash: fs.length ? `clip(${fs.join('+')},-1,1)` : '',
  }
}

export async function buildExport(project: Project, root: string, opts: ExportOpts, rot?: { dir: string; t0: number; t1: number }, rotDetras?: { dir: string; t0: number; t1: number }) {
  const fps = project.format.fps || 30
  const scale = opts.resolucion === 'original' ? 1 : (opts.resolucion === '720' ? 720 : 480) / Math.min(project.format.width, project.format.height)
  const W = even(project.format.width * Math.min(scale, 1)), H = even(project.format.height * Math.min(scale, 1))
  const total = duration(project)
  if (total <= 0) throw new Error('La edición está vacía')
  const assets = new Map(project.assets.map(a => [a.id, a]))
  const srcOf = async (id: string) => {
    const a = assets.get(id)!
    for (const f of [...(a.kind === 'image' ? [path.join(root, decodeURIComponent((a.proxy ?? '').replace(/^api\/files\//, '')))] : []), a.original, path.join(root, decodeURIComponent((a.proxy ?? '').replace(/^api\/files\//, '')))]) { if (f && path.isAbsolute(f) && await fsp.stat(f).then(s => s.isFile()).catch(() => false)) return f }
    throw new Error(`No encuentro el archivo "${a.name}". Ubícalo de nuevo en el Material.`)
  }
  const voces = new Map<string, string>()      // asset → audio ya limpio y nivelado (si la mejora de voz está activa y el archivo existe)
  if (project.mejoras?.audio) for (const a of project.assets) { const f = vozPath(root, a); if (a.kind !== 'audio' && await fileOk(f)) voces.set(a.id, f) }
  const vozFile = (id: string) => voces.get(id)
  const recortes = new Map<string, string>()      // asset → máscara de la persona (solo si hay texto detrás de la persona)
  if (rotDetras) for (const a of project.assets) { const f = recortePath(root, a); if (a.kind !== 'audio' && await fileOk(f)) recortes.set(a.id, f) }
  const inputs: string[][] = []
  const audioCache = new Map<string, boolean>()
  const hasAudio = async (f: string) => { if (!audioCache.has(f)) audioCache.set(f, await probeAudio(f)); return audioCache.get(f)! }
  const addInput = (ss: number, len: number, file: string) => { inputs.push(/\.(jpe?g|png|webp)$/i.test(file) ? ['-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', file] : ['-ss', num(ss), '-t', num(len), '-i', file]); return inputs.length - 1 }      // una imagen se repite como video fijo

  const ts = (k: string) => project.tracks?.[k] ?? {}
  const vf: string[] = [], audio: string[] = []
  const placed = layout(project)
  const A_FMT = 'aformat=sample_rates=44100:channel_layouts=stereo'

  // 1) pista principal
  const vlabels: string[] = [], plabels: string[] = []
  for (const [i, pl] of placed.entries()) {
    const c = pl.clip, D = pl.end - pl.start, file = await srcOf(c.assetId)
    const k = addInput(c.srcIn, (c.srcOut - c.srcIn) + 0.3, file)
    const fx = fxExpr(c, placed[i + 1]?.clip, D, fps), tf = c.transform
    // encuadre: con zoom/deslizamiento se usa zoompan (a doble resolución para que el zoom no pixele); sin ellos se escala directo (mucho más rápido)
    const conZoom = fx.z !== '1' || fx.x !== 'iw/2-(iw/zoom/2)' || fx.y !== 'ih/2-(ih/zoom/2)'
    const encuadre = conZoom
      ? `scale=${2 * W}:${2 * H}:force_original_aspect_ratio=decrease,pad=${2 * W}:${2 * H}:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='${fx.z}':x='${fx.x}':y='${fx.y}':d=1:s=${W}x${H}:fps=${fps}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`
    const voz = vozFile(c.assetId), ka = voz ? addInput(c.srcIn, (c.srcOut - c.srcIn) + 0.3, voz) : k      // la voz sale del audio ya limpio y nivelado
    if (!ts('main').hidden) {
    const eq = fx.flash ? `,eq=brightness='${fx.flash}':eval=frame` : ''
    const gpx = fx.glitch ? Math.max(2, Math.round(fx.glitch.amt * 0.04 * W)) : 0       // separación de color en px de salida (igual que la vista previa: 4 % del ancho × intensidad)
    const gl = fx.glitch ? `,format=gbrp,rgbashift=rh=-${gpx}:bh=${gpx}:enable='lt(t,${num(fx.glitch.dur)})',format=yuv420p` : ''
    vf.push(`[${k}:v]setpts=(PTS-STARTPTS)/${num(c.speed)},fps=${fps}${colorChain(c.color)},${encuadre}${eq}${gl},trim=duration=${num(D)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p${tf ? `,scale=w='trunc(iw*${num(tf.scale)}/2)*2':h='trunc(ih*${num(tf.scale)}/2)*2',rotate=a=${num(tf.rotation * Math.PI / 180)}:ow='rotw(${num(tf.rotation * Math.PI / 180)})':oh='roth(${num(tf.rotation * Math.PI / 180)})':c=black,setsar=1` : ''}[${tf ? 'vt' : 'v'}${i}]`)
    if (tf) {     // el video movido/agrandado/girado se pone sobre negro en su posición (igual que la vista previa: el cuadro entero se transforma alrededor de su centro)
      vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(D)}[kb${i}]`)
      vf.push(`[kb${i}][vt${i}]overlay=x=${num(tf.x * W)}-w/2:y=${num(tf.y * H)}-h/2:eof_action=pass,format=yuv420p,setsar=1[v${i}]`)
    }
    if (rotDetras) {       // la persona recortada de ESTE clip (mismo encuadre, zoom y movimiento que el video) para ponerla por encima del texto que va detrás
      const mf = recortes.get(c.assetId)
      if (mf) {
        const km = addInput(c.srcIn, (c.srcOut - c.srcIn) + 0.3, mf)
        vf.push(`[${km}:v]setpts=(PTS-STARTPTS)/${num(c.speed)},fps=${fps},${encuadre},trim=duration=${num(D)},setpts=PTS-STARTPTS,setsar=1,format=gray${tf ? `,scale=w='trunc(iw*${num(tf.scale)}/2)*2':h='trunc(ih*${num(tf.scale)}/2)*2',rotate=a=${num(tf.rotation * Math.PI / 180)}:ow='rotw(${num(tf.rotation * Math.PI / 180)})':oh='roth(${num(tf.rotation * Math.PI / 180)})':c=black,setsar=1` : ''}[${tf ? 'mt' : 'm'}${i}]`)
        if (tf) {
          vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(D)},format=gray[kbm${i}]`)
          vf.push(`[kbm${i}][mt${i}]overlay=x=${num(tf.x * W)}-w/2:y=${num(tf.y * H)}-h/2:eof_action=pass,format=gray[m${i}]`)
        }
        vf.push(`[v${i}]split=2[v${i}a][v${i}b]`)
        vf.push(`[v${i}b]format=yuva420p[v${i}c]`, `[v${i}c][m${i}]alphamerge[p${i}]`)
        vlabels.push(`[v${i}a]`); plabels.push(`[p${i}]`)
      } else {
        vf.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(D)},format=yuva420p[p${i}]`)       // clip sin recorte: persona transparente (no tapa nada)
        vlabels.push(`[v${i}]`); plabels.push(`[p${i}]`)
      }
    } else vlabels.push(`[v${i}]`)
    }
    if (!ts('main').muted && c.volume > 0 && await hasAudio(voz ?? file)) audio.push(`[${ka}:a]asetpts=PTS-STARTPTS,${A_FMT},${atempoChain(c.speed)},volume=${num(c.volume)},atrim=0:${num(D)},adelay=${Math.round(pl.start * 1000)}:all=1[ac${i}]`)
  }
  vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(total)}[base]`)
  let cur = 'base'
  if (vlabels.length) { vf.push(`${vlabels.join('')}concat=n=${vlabels.length}:v=1:a=0[main]`); vf.push(`[base][main]overlay=0:0:eof_action=pass[b0]`); cur = 'b0' }
  if (rotDetras && plabels.length && cur === 'b0') {       // texto detrás de la persona: video → texto → persona recortada por encima
    inputs.push(['-f', 'concat', '-safe', '0', '-i', path.join(rotDetras.dir, 'lista.txt')]); const kd = inputs.length - 1
    vf.push(`[${kd}:v]setpts=PTS-STARTPTS+${num(rotDetras.t0)}/TB,format=rgba[txd]`)
    vf.push(`[b0][txd]overlay=0:0:eof_action=pass:enable='between(t,${num(rotDetras.t0)},${num(rotDetras.t1)})'[bd]`)
    vf.push(`${plabels.join('')}concat=n=${plabels.length}:v=1:a=0[persona]`)
    vf.push(`[bd][persona]overlay=0:0:eof_action=pass,format=yuv420p[b1]`); cur = 'b1'
  }

  // 2) clips superpuestos: video encima (pista baja primero) y audio
  const ovs = [...(project.overlays ?? [])].sort((a, b) => a.track - b.track || a.start - b.start)
  for (const [j, o] of ovs.entries()) {
    const file = await srcOf(o.assetId), D = overlayDur(o)
    const k = addInput(o.srcIn, (o.srcOut - o.srcIn) + 0.3, file)
    const vozO = o.kind === 'video' ? vozFile(o.assetId) : undefined, kaO = vozO ? addInput(o.srcIn, (o.srcOut - o.srcIn) + 0.3, vozO) : k
    if (o.kind === 'video' && o.blend === 'screen' && !ts('v' + o.track).hidden) {
      // luz (screen): cubre todo el cuadro; ambos lados en el MISMO formato (gbrp) o el color sale desviado (magenta)
      const st = num(o.start), en = num(o.start + D), kb = `kb${j}`
      vf.push(`[${k}:v]setpts=(PTS-STARTPTS)/${num(o.speed)}+${st}/TB,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=gbrp[sc${j}]`)
      vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(duration(project))},format=gbrp[${kb}]`)
      vf.push(`[${kb}][sc${j}]overlay=0:0:eof_action=pass:enable='between(t,${st},${en})'[kl${j}]`)
      vf.push(`[${cur}]format=gbrp[cf${j}]`)
      vf.push(`[cf${j}][kl${j}]blend=all_mode=screen:all_opacity=${num(o.transform.opacity)}[b${j + 1}]`)
      cur = `b${j + 1}`
    } else if (o.kind === 'video' && o.mascara && !ts('v' + o.track).hidden) {
      // CARD con máscara (p. ej. 4:5 redondeada): el video completo se encuadra detrás de la ventana; con '3d' entra y sale girando en perspectiva.
      // Lienzo con márgenes transparentes (el giro agranda el lado cercano) → máscara fija (un solo cuadro con geq, repetido con loop: barato) → perspective.
      const m = o.mascara, mw = Math.round(m.w * W / 2) * 2, mh = Math.round(mw / m.aspect / 2) * 2
      const px = Math.round(mh * 0.1 / 2) * 2, py = Math.round(mh * 0.18 / 2) * 2, PW = mw + 2 * px, PH = mh + 2 * py, R = num(m.r * mw)
      const mx0 = m.x * W - mw / 2, my0 = m.y * H - mh / 2, st = num(o.start), dd = num(D + 0.1)
      const cr = o.crop ? `,crop=iw*${num(1 - o.crop.l - o.crop.r)}:ih*${num(1 - o.crop.t - o.crop.b)}:iw*${num(o.crop.l)}:ih*${num(o.crop.t)}` : ''
      vf.push(`[${k}:v]setpts=(PTS-STARTPTS)/${num(o.speed)}+${st}/TB,fps=${fps}${cr}${o.blend ? '' : colorChain(o.color)},scale=w='trunc(min(${W}/iw,${H}/ih)*iw*${num(o.transform.scale)}/2)*2':h=-2,format=rgba[cc${j}]`)
      vf.push(`color=c=black:s=${PW}x${PH}:r=${fps}:d=${dd},setpts=PTS-STARTPTS+${st}/TB,format=rgba[cb${j}]`)
      vf.push(`[cb${j}][cc${j}]overlay=x='${num(o.transform.x * W - mx0 + px)}-w/2':y='${num(o.transform.y * H - my0 + py)}-h/2':eof_action=repeat[cv${j}]`)
      const sd = `(hypot(max(abs(X-${PW / 2})-${num(mw / 2)}+${R},0),max(abs(Y-${PH / 2})-${num(mh / 2)}+${R},0))+min(max(abs(X-${PW / 2})-${num(mw / 2)}+${R},abs(Y-${PH / 2})-${num(mh / 2)}+${R}),0)-${R})`
      vf.push(`color=c=black:s=${PW}x${PH}:r=${fps}:d=${num(1 / fps)},format=gray,geq=lum='255*clip(0.5-${sd},0,1)',loop=loop=-1:size=1,trim=duration=${dd},setpts=N/(${fps}*TB)+${st}/TB[mk${j}]`)
      const fd = o.transicion === '3d' ? CARD3D.fundido : 0.35
      const fades = o.transicion ? `,fade=t=in:st=${st}:d=${num(fd)}:alpha=1,fade=t=out:st=${num(Math.max(o.start, o.start + D - fd))}:d=${num(fd)}:alpha=1` : ''
      let persp = ''
      if (o.transicion === '3d') {
        const dir = ladoCard(o.id), U = `(in/${fps})`, x = `clip(${U}/${CARD3D.entra},0,1)`, v = `clip((${U}-${num(D - CARD3D.sale)})/${CARD3D.sale},0,1)`
        const A = `(${dir}*(1-(1+2.70158*pow(${x}-1,3)+1.70158*pow(${x}-1,2)))*${CARD3D.max}-${dir}*pow(${v},2)*${CARD3D.max})`
        const Dd = num(mw * CARD3D.dist), hw = PW / 2, hh = PH / 2
        const sL = `${Dd}/(${Dd}-${hw}*sin(${A}))`, sR = `${Dd}/(${Dd}+${hw}*sin(${A}))`
        const xl = `${hw}-${hw}*cos(${A})*${sL}`, xr = `${hw}+${hw}*cos(${A})*${sR}`
        persp = `,perspective=x0='${xl}':y0='${hh}-${hh}*${sL}':x1='${xr}':y1='${hh}-${hh}*${sR}':x2='${xl}':y2='${hh}+${hh}*${sL}':x3='${xr}':y3='${hh}+${hh}*${sR}':sense=destination:eval=frame`
      }
      vf.push(`[cv${j}][mk${j}]alphamerge,colorchannelmixer=aa=${num(o.transform.opacity)}${fades}${persp}[ov${j}]`)
      vf.push(`[${cur}][ov${j}]overlay=x=${Math.round(mx0 - px)}:y=${Math.round(my0 - py)}:eof_action=pass:enable='between(t,${st},${num(o.start + D)})'[b${j + 1}]`)
      cur = `b${j + 1}`
    } else if (o.kind === 'video' && !ts('v' + o.track).hidden) {
      const R = `(min(W,H)*0.06)`
      const pack = assets.get(o.assetId)?.alfa === 'pack'     // video con transparencia (color | alfa lado a lado): se separa y se funde con alphamerge
      if (pack) {
        vf.push(`[${k}:v]split[pks${j}][pkm${j}]`)
        vf.push(`[pks${j}]crop=iw/2:ih:0:0[pkc${j}]`)
        vf.push(`[pkm${j}]crop=iw/2:ih:iw/2:0,negate,format=gray[pkg${j}]`)
        vf.push(`[pkc${j}][pkg${j}]alphamerge,unpremultiply=inplace=1[pku${j}]`)
      }
      const round = `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(X-W/2)-(W/2-${R}),0)*gt(abs(Y-H/2)-(H/2-${R}),0)*gt(hypot(abs(X-W/2)-(W/2-${R}),abs(Y-H/2)-(H/2-${R})),${R}),0,alpha(X,Y))'`
      const cr = o.crop ? `,crop=iw*${num(1 - o.crop.l - o.crop.r)}:ih*${num(1 - o.crop.t - o.crop.b)}:iw*${num(o.crop.l)}:ih*${num(o.crop.t)}` : ''
      vf.push(`[${pack ? `pku${j}` : `${k}:v`}]setpts=(PTS-STARTPTS)/${num(o.speed)}+${num(o.start)}/TB,fps=${fps}${cr}${pack || o.blend ? '' : colorChain(o.color)},scale=w='trunc(min(${W}/iw,${H}/ih)*iw*${num(o.transform.scale)}/2)*2':h=-2,format=rgba,${pack ? '' : round + ','}colorchannelmixer=aa=${num(o.transform.opacity)}${o.transicion ? `,fade=t=in:st=${num(o.start)}:d=0.35:alpha=1,fade=t=out:st=${num(Math.max(o.start, o.start + D - 0.3))}:d=0.3:alpha=1` : ''}${o.transform.rotation ? `,rotate=a=${num(o.transform.rotation * Math.PI / 180)}:ow='rotw(${num(o.transform.rotation * Math.PI / 180)})':oh='roth(${num(o.transform.rotation * Math.PI / 180)})':c=none` : ''}[ov${j}]`)
      vf.push(`[${cur}][ov${j}]overlay=x='${num(W * o.transform.x)}-w/2':y='${num(H * o.transform.y)}-h/2${o.transicion === 'subir' ? `+${num(H * 0.025)}*pow(max(0,1-(t-${num(o.start)})/0.35),2)` : ''}':eof_action=pass:enable='between(t,${num(o.start)},${num(o.start + D)})'[b${j + 1}]`)
      cur = `b${j + 1}`
    }
    if (!ts((o.kind === 'video' ? 'v' : 'a') + o.track).muted && o.volume > 0 && await hasAudio(vozO ?? file)) audio.push(`[${kaO}:a]asetpts=PTS-STARTPTS,${A_FMT},${atempoChain(o.speed)},volume=${num(o.volume)},atrim=0:${num(D)}${o.fundido?.entrada ? `,afade=t=in:st=0:d=${num(o.fundido.entrada)}` : ''}${o.fundido?.salida ? `,afade=t=out:st=${num(Math.max(0, D - o.fundido.salida))}:d=${num(o.fundido.salida)}` : ''},adelay=${Math.round(o.start * 1000)}:all=1[ao${j}]`)
  }

  // 3) música
  if (project.music && assets.has(project.music.assetId) && project.music.volume > 0 && !ts('music').muted) {
    const m = project.music, file = await srcOf(m.assetId)
    const k = addInput(m.srcIn, total + 0.3, file)
    const fade = m.fadeOut > 0 ? `,afade=t=out:st=${num(Math.max(0, total - m.fadeOut))}:d=${num(m.fadeOut)}` : ''
    audio.push(`[${k}:a]asetpts=PTS-STARTPTS,${A_FMT},volume=${num(m.volume)}${fade},atrim=0:${num(total)}[am]`)
  }

  // 4) rótulos (subtítulos y gráficos): secuencia de PNG con transparencia dibujada por el editor, encima de todo
  if (rot) {
    inputs.push(['-f', 'concat', '-safe', '0', '-i', path.join(rot.dir, 'lista.txt')]); const k = inputs.length - 1
    vf.push(`[${k}:v]setpts=PTS-STARTPTS+${num(rot.t0)}/TB,format=rgba[txt]`)
    vf.push(`[${cur}][txt]overlay=0:0:eof_action=pass:enable='between(t,${num(rot.t0)},${num(rot.t1)})'[btxt]`); cur = 'btxt'
  }

  vf.push(`[${cur}]null[v]`)
  const labels = audio.map(l => /\[(a[a-z]+\d*)\]$/.exec(l)![1])
  let hasA = false
  if (labels.length) {
    hasA = true
    vf.push(...audio)
    vf.push(`${labels.map(l => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,atrim=0:${num(total)},alimiter=limit=0.97[a]`)
  }
  return { inputs, filter: vf.join(';\n'), hasA, W, H, fps, total, mainTotal: mainDuration(project) }
}

/** Lanza la exportación en segundo plano. */
export interface Exportado { slug: string; name: string; ruta: string; size: number; fecha: string }

/** Mueve el archivo (rename; si es otro disco, copia y borra). */
async function mover(src: string, dst: string) {
  try { await fsp.rename(src, dst) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; await fsp.copyFile(src, dst); await fsp.rm(src, { force: true }) }
}
async function nombreLibre(dir: string, name: string) {
  const ext = path.extname(name), base = path.basename(name, ext)
  for (let i = 1; ; i++) { const f = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`); if (!(await fsp.stat(f).then(() => true).catch(() => false))) return f }
}

export async function startExport(slug: string, projectFile: string, outDir: string, root: string, opts: ExportOpts, origin: string, carpeta: string, registrar: (e: Exportado) => Promise<void>): Promise<ExportJob> {
  const running = activeExport(slug); if (running) return running
  const job: ExportJob = { id: `${slug}-${Date.now()}`, slug, status: 'running', pct: 0, opts, detail: 'Preparando…' }
  jobs.set(job.id, job)
  void (async () => {
    try {
      const raw = parseProject(await fsp.readFile(projectFile, 'utf8'))     // también abre y migra proyectos de versiones anteriores
      let marca = Date.now(); job.tiempos = {}
      const etapa = (n: string) => { const a = Date.now(); job.tiempos![n] = Math.round((a - marca) / 100) / 10; marca = a }
      // rótulos visibles (no ocultos): se dibujan primero con Chromium sin pantalla
      const tr = raw.tracks, texts = raw.layers.filter(l => (l.type === 'subtitle' || l.type === 'graphic') && !tr?.[l.type]?.hidden)
      const total = duration(raw)
      let rot: { dir: string; t0: number; t1: number } | undefined, rotDetras: { dir: string; t0: number; t1: number } | undefined
      const sc = opts.resolucion === 'original' ? 1 : (opts.resolucion === '720' ? 720 : 480) / Math.min(raw.format.width, raw.format.height)
      const ow = Math.max(2, Math.round(raw.format.width * Math.min(sc, 1) / 2) * 2), oh = Math.max(2, Math.round(raw.format.height * Math.min(sc, 1) / 2) * 2)
      if (texts.length) {
        job.detail = 'Dibujando rótulos…'
        // texto DETRÁS de la persona: solo si hay gráficos marcados y existe el recorte de al menos un video usado; si no, todo va al frente
        const detras = texts.filter(l => l.type === 'graphic' && l.props?.detras === '1')
        const hayRecorte = detras.length > 0 && (await Promise.all(raw.clips.map(c => { const a = raw.assets.find(x => x.id === c.assetId); return a ? fileOk(recortePath(root, a)) : false }))).some(Boolean)
        const rango = (ls: typeof texts) => ({ t0: Math.max(0, Math.min(...ls.map(l => l.start))), t1: Math.min(total, Math.max(...ls.map(l => l.end))) })
        const frente = hayRecorte ? texts.filter(l => !detras.includes(l)) : texts
        if (frente.length) {
          const { t0, t1 } = rango(frente), dir = path.join(outDir, '.rotulos'); await fsp.rm(dir, { recursive: true, force: true })
          await renderRotulos({ origin, slug, w: ow, h: oh, fps: raw.format.fps || 30, t0, t1, outDir: dir, capa: hayRecorte ? 'frente' : 'todas', cancelled: () => !!job.cancelada, onProgress: p => { job.pct = p * (hayRecorte ? 0.12 : 0.25) } })
          rot = { dir, t0, t1 }
        }
        if (hayRecorte) {
          const { t0, t1 } = rango(detras), dir = path.join(outDir, '.rotulos-detras'); await fsp.rm(dir, { recursive: true, force: true })
          await renderRotulos({ origin, slug, w: ow, h: oh, fps: raw.format.fps || 30, t0, t1, outDir: dir, capa: 'detras', cancelled: () => !!job.cancelada, onProgress: p => { job.pct = 0.12 + p * 0.13 } })
          rotDetras = { dir, t0, t1 }
        }
      }
      etapa('rotulos')
      if (raw.mejoras?.audio) { job.detail = 'Limpiando el audio…'; await asegurarVoz(raw.assets, root, p => { job.pct = Math.max(job.pct, p * 0.05) }) }
      etapa('voz')
      const b = await buildExport(raw, root, opts, rot, rotDetras)
      await fsp.mkdir(outDir, { recursive: true })
      const safe = (opts.nombre ?? slug).normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || slug
      const name = `${safe}-${b.W}x${b.H}.mp4`, out = path.join(outDir, name), tmp = out + '.part.mp4', script = path.join(outDir, '.exportar.filter.txt')
      await fsp.writeFile(script, b.filter)
      const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', ...b.inputs.flat(), '-/filter_complex', script, '-map', '[v]', ...(b.hasA ? ['-map', '[a]'] : []),
        '-c:v', 'libx264', ...QUALITY[opts.calidad], '-pix_fmt', 'yuv420p', '-r', String(b.fps), ...(b.hasA ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', '-f', 'mp4', tmp]
      job.detail = 'Renderizando…'
      await new Promise<void>((resolve, reject) => {
        const p = spawn('ffmpeg', args); procs.set(job.id, p)
        let err = ''
        p.stdout.on('data', d => { const m = /out_time_us=(\d+)/g; let x, last = 0; const s = String(d); while ((x = m.exec(s))) last = Number(x[1]); if (last) job.pct = Math.min(0.99, ((rot || rotDetras) ? 0.25 : 0) + (1 - ((rot || rotDetras) ? 0.25 : 0)) * (last / 1e6 / b.total)) })
        p.stderr.on('data', d => { err += d })
        p.on('error', reject)
        p.on('close', code => code === 0 ? resolve() : reject(new Error(job.cancelada ? 'Cancelado' : 'ffmpeg falló: ' + err.slice(-400))))
      })
      etapa('ffmpeg'); console.log('[exportar] tiempos (s):', JSON.stringify(job.tiempos))
      await fsp.writeFile(path.join(outDir, 'ultima-exportacion.tiempos.json'), JSON.stringify({ fecha: new Date().toISOString(), duracion: total, opts, tiempos: job.tiempos }, null, 2)).catch(() => {})      // para revisar qué etapa tarda
      await fsp.rm(script, { force: true }); await fsp.rm(path.join(outDir, '.rotulos'), { recursive: true, force: true }); await fsp.rm(path.join(outDir, '.rotulos-detras'), { recursive: true, force: true })
      await fsp.rename(tmp, out)
      const dest = await nombreLibre(carpeta, name)          // el video final queda en la carpeta que eligió el usuario, no escondido en la biblioteca
      await mover(out, dest)
      job.file = dest; job.size = (await fsp.stat(dest)).size; job.url = `api/exportado?ruta=${encodeURIComponent(dest)}`; job.pct = 1; job.status = 'done'; job.detail = undefined
      await registrar({ slug, name: path.basename(dest), ruta: dest, size: job.size, fecha: new Date().toISOString() })
    } catch (e) {
      await fsp.rm(path.join(outDir, '.exportar.filter.txt'), { force: true }).catch(() => {}); await fsp.rm(path.join(outDir, '.rotulos'), { recursive: true, force: true }).catch(() => {})
      for (const f of await fsp.readdir(outDir).catch(() => [] as string[])) if (f.endsWith('.part.mp4')) await fsp.rm(path.join(outDir, f), { force: true })
      if (job.cancelada) { job.status = 'cancelado'; job.error = 'Exportación cancelada' } else { job.status = 'error'; job.error = (e as Error).message }
    } finally { procs.delete(job.id) }
  })()
  return job
}

export function cancelExport(id: string) {
  const j = jobs.get(id); if (!j || j.status !== 'running') return
  j.cancelada = true; procs.get(id)?.kill('SIGKILL')
}
