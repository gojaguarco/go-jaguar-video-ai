import { parseProject } from '@gojaguar/core'
import { setCanvasSize } from './constants'
import { drawOverlays, esDetras, preloadOverlayImages, visibleOverlays } from './overlays'

/**
 * Página que usa la exportación (Chromium sin pantalla): dibuja solo los rótulos (subtítulos y gráficos) sobre fondo transparente,
 * con el MISMO código que el editor, y entrega cada fotograma como PNG. Así lo que ves es lo que sale en el MP4.
 */
export async function bootRender(slug: string, outW: number, outH: number) {
  document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent'; document.body.style.margin = '0'
  for (const id of ['shell', 'app']) document.getElementById(id)?.remove()
  const project = parseProject(await (await fetch(`/api/proyectos/${slug}/proyecto`)).text())
  setCanvasSize(project.format)
  const { W, H } = await import('./constants')
  await Promise.all([...['900', '800', '700', '600'].map(w => document.fonts.load(`${w} 40px Figtree`)), document.fonts.load('900 40px Montserrat')])
  await preloadOverlayImages(project)
  const cv = document.createElement('canvas'); cv.width = outW; cv.height = outH; document.body.append(cv)
  const ctx = cv.getContext('2d')!
  const capa = (new URLSearchParams(location.hash.split('?')[1] ?? '').get('capa') ?? 'todas') as 'todas' | 'detras' | 'frente'
  const tr = project.tracks
  const shown = tr?.subtitle?.hidden || tr?.graphic?.hidden ? { ...project, layers: project.layers.filter(l => !tr?.[l.type]?.hidden) } : project
  const visibles = (t: number) => visibleOverlays(shown, t).filter(o => capa === 'todas' || (capa === 'detras') === esDetras(o))
  let ultimaFirma = 0
  ;(window as any).__vacio = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, outW, outH); return cv.toDataURL('image/png') }
  ;(window as any).__draw = (t: number) => {
    if (!visibles(t).length) { ultimaFirma = 0; return '' }          // nada que dibujar: no se codifica un PNG vacío en cada cuadro
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, outW, outH)
    ctx.setTransform(outW / W, 0, 0, outH / H, 0, 0)
    drawOverlays(ctx, shown, t, null, capa)
    // firma barata del cuadro: si es idéntico al anterior no se codifica otro PNG (los rótulos quietos repiten miles de cuadros)
    const px = ctx.getImageData(0, 0, outW, outH).data; let h = 2166136261
    for (let i = 3; i < px.length; i += 61) h = Math.imul(h ^ (px[i] + px[i - 1] * 7 + px[i - 2] * 13), 16777619)
    if (h === ultimaFirma) return 'igual'
    ultimaFirma = h
    return cv.toDataURL('image/png')
  }
  ;(window as any).__ready = true
}
