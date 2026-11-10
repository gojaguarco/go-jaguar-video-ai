import {
  CLIP_COLOR_DEFAULT, CLIP_TRANSFORM_DEFAULT, Store, describe, formatoDe, duration, exec, execBatch, layout, locate, overlayEnd, parseProject, serialize, sincronizarPalabras,
  TRANSITION_DEFAULTS, TRANSITION_KINDS, setAlComando, verificar, ZOOM_DEFAULTS, ZOOM_KINDS, type AssetInfo, type Cmd, type TransitionKind, type ZoomKind, type Project, type TextLayer,
} from '@gojaguar/core'
import { TRANSITION_INFO, ZOOM_INFO } from './fxinfo'
import { H, W } from './constants'
import { ico } from './icons'
import { runBench } from './bench'
import { loadAsset, loadAudioFrom, loadImage } from './media'
import { aLocal, geomOf, guias, hitAsa, hitOverlay, transformEfectivo, visibleOverlays } from './overlays'
import { Player } from './player'
import { Timeline } from './timeline'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const tc = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`

export async function bootEditor(slug: string) {
  // verificación previa: si falta algún archivo NO se entra al editor (se quedaría cargando): se explica qué falta y se ofrece arreglarlo
  let avisos: string[] = []
  try {
    const v = await fetch(`/api/proyectos/${slug}/verificacion?para=editor`).then(r => r.json()) as { ok: boolean; problemas: { mensaje: string; reparable?: boolean }[]; avisos: string[] }
    avisos = v.avisos ?? []
    if (!v.ok) {
      const rep = v.problemas.some(p => p.reparable)
      $('loading').innerHTML = `<div style="max-width:560px;margin:0 auto;text-align:left;display:flex;flex-direction:column;gap:12px"><b>No se puede abrir el editor todavía</b>
        <ul style="margin:0;padding-left:20px;line-height:1.5">${v.problemas.map(p => `<li>${p.mensaje.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</li>`).join('')}</ul>
        <div style="display:flex;gap:8px">${rep ? '<button id="reparar" class="primary">Reparar</button>' : ''}<a href="#/p/${slug}">${ico('arrow-left')} Volver al proyecto</a></div></div>`
      const b = document.getElementById('reparar'); if (b) b.onclick = async () => { (b as HTMLButtonElement).disabled = true; b.textContent = 'Reparando…'; await fetch(`/api/proyectos/${slug}/reparar`, { method: 'POST' }); location.reload() }
      return
    }
  } catch { /* sin verificación: se intenta abrir igual */ }
  const lento = window.setTimeout(() => { const l = document.getElementById('loading'); if (l) l.innerHTML += `<div style="margin-top:12px;opacity:.8">Está tardando más de lo normal. Si no abre, vuelve al proyecto y revisa que los videos estén en su lugar.<br><a href="#/p/${slug}">${ico('arrow-left')} Volver al proyecto</a></div>` }, 25000)
  const res = await fetch(`/api/proyectos/${slug}/proyecto`)
  if (!res.ok) { $('loading').innerHTML = `${(await res.json().catch(() => ({ error: 'Error' }))).error}<br><a href="#/p/${slug}">${ico('arrow-left')} Volver al proyecto</a>`; return }
  const store = new Store(parseProject(await res.text()))
  store.load(store.project)   // el estado inicial no es deshacible
  const player = new Player($('preview') as HTMLCanvasElement, store)
  const tl = new Timeline($('timeline') as HTMLCanvasElement, store, player)

  /** Carga los medios que el proyecto usa y aún no están en memoria. */
  const loadingIds = new Set<string>()
  async function loadMedia() {
    for (const info of store.project.assets) {
      if (player.assets.has(info.id) || player.music.has(info.id) || loadingIds.has(info.id)) continue
      loadingIds.add(info.id)
      if (info.kind === 'image') {
        try { player.images.set(info.id, await loadImage(`/${info.proxy}`)); tl.dirty = true; player.dirty = true }
        catch (e) { notify(`No se pudo cargar la imagen "${info.name}": ${(e as Error).message}`) }
        continue
      }
      if (info.kind === 'audio') {
        try { player.addMusic(info.id, await player.actx.decodeAudioData(await (await fetch(`/${info.proxy}`)).arrayBuffer())); tl.dirty = true }
        catch (e) { notify(`No se pudo cargar la música "${info.name}": ${(e as Error).message}`) }
        continue
      }
      try {
        player.assets.set(info.id, await loadAsset(info, player.actx, () => { tl.dirty = true }))
        const murl = info.proxy.replace(/\.proxy\.mp4$/, '.recorte.mp4')      // ¿hay recorte de la persona? (texto detrás de ella)
        void fetch(`/${murl}`, { headers: { Range: 'bytes=0-1' } }).then(async r => { if (r.ok && r.headers.get('content-type')?.includes('video')) { player.mattes.set(info.id, await loadAsset({ ...info, id: info.id + '#recorte', proxy: murl }, player.actx, () => {})); player.dirty = true } }).catch(() => {})
      }
      catch (e) { notify(`No se pudo cargar "${info.name}": ${(e as Error).message}`) }
    }
    player.ensureStretched()
  }
  // Voz limpia y pareja (procedimiento estándar): si el proyecto la tiene activa, el audio de los videos es el ya procesado
  // (`<video>.voz2.m4a`, el MISMO que usa la exportación); si se desactiva, vuelve el audio original.
  const vozDe = new Map<string, boolean>()      // asset → ¿tiene cargada la voz procesada?
  let vozOcupada = false
  async function sincronizarVoz() {
    if (vozOcupada) return
    const on = !!store.project.mejoras?.audio
    const falta = [...player.assets.values()].filter(a => (vozDe.get(a.info.id) ?? false) !== on)
    if (!falta.length) return
    vozOcupada = true
    try {
      let voces: Record<string, string> = {}
      if (on) { notify('Limpiando el ruido y nivelando la voz…'); voces = (await (await fetch(`/api/proyectos/${slug}/mejorar-audio`, { method: 'POST' })).json()).voces ?? {} }
      for (const a of falta) {
        const url = on ? voces[a.info.id] : a.info.proxy
        if (!url) { vozDe.set(a.info.id, on); continue }
        try { await loadAudioFrom(a, `/${url}`, player.actx); vozDe.set(a.info.id, on); player.refreshAudio(a.info.id); tl.dirty = true } catch (e) { notify(`No se pudo cambiar el audio de "${a.info.name}": ${(e as Error).message}`) }
      }
      if (on) notify('Voz limpia y pareja lista')
    } finally { vozOcupada = false }
    void sincronizarVoz()      // por si cambió mientras tanto
  }
  await loadMedia()
  setTimeout(() => void sincronizarVoz(), 300)      // (después de armar el aviso de la cabecera)
  clearTimeout(lento)
  $('loading').remove()
  requestAnimationFrame(() => { tl.fit(); player.seek(0) })

  // --- avisos y nombre del proyecto ------------------------------------------------
  const noteEl = $('note')
  let noteTimer = 0
  function notify(msg: string) {
    noteEl.textContent = msg
    clearTimeout(noteTimer); noteTimer = window.setTimeout(() => { noteEl.textContent = '' }, 5000)
  }
  const nameEl = $<HTMLInputElement>('pname')
  nameEl.value = store.project.name
  // El nombre se ve como texto; con doble clic se puede editar (Enter guarda, Esc cancela)
  const fitName = () => { nameEl.style.width = `${Math.max(8, nameEl.value.length + 2)}ch` }
  fitName()
  const endEdit = (save: boolean) => {
    if (nameEl.readOnly) return
    if (save) store.mutate(p => { p.name = nameEl.value.trim() || 'Proyecto sin título' })
    nameEl.value = store.project.name; nameEl.readOnly = true; nameEl.blur(); fitName()
  }
  nameEl.addEventListener('dblclick', () => { nameEl.readOnly = false; nameEl.focus(); nameEl.select() })
  nameEl.addEventListener('input', fitName)
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') endEdit(true); else if (e.key === 'Escape') endEdit(false) })
  nameEl.addEventListener('blur', () => endEdit(true))

  // --- guardado en la carpeta del proyecto (autoguardado + botón) -----------------------------------------
  let lastSavedRev = store.revision
  let lastJson = JSON.stringify(store.project), savedJson = lastJson
  const saveEl = $('savestate')
  const showSaved = (ok: boolean) => { saveEl.textContent = ok ? '✓ Guardado' : 'Guardando…'; saveEl.dataset.icon = ok ? '✓' : '…'; saveEl.style.color = ok ? '' : '#e8b152' }
  showSaved(true)
  let autosaveTimer = 0
  async function guardar(avisar = false) {
    const rev = store.revision, snapJson = JSON.stringify(store.project)
    try {
      const r = await fetch(`/api/proyectos/${slug}/proyecto`, { method: 'PUT', body: serialize(store.project) })
      if (!r.ok) throw new Error('El servidor no pudo guardar')
      lastSavedRev = rev
      savedJson = snapJson
      showSaved(JSON.stringify(store.project) === snapJson)
      if (avisar) notify('Guardado')
    } catch (e) { notify('No se pudo guardar: ' + (e as Error).message) }
  }
  store.onChange(() => {
    if (document.activeElement !== nameEl) { nameEl.value = store.project.name; fitName() }
    const json = JSON.stringify(store.project)      // seleccionar o mover el cabezal no cambia la edición: no se guarda
    if (json === lastJson) return
    lastJson = json
    showSaved(false)
    clearTimeout(autosaveTimer)
    autosaveTimer = window.setTimeout(() => { void guardar() }, 1200)
  })
  // el logo lleva a la página principal (todos los proyectos), guardando antes
  $('home').onclick = async e => { e.preventDefault(); await guardar(); location.hash = '#/' }
  window.addEventListener('beforeunload', e => { if (JSON.stringify(store.project) !== savedJson) e.preventDefault() })

  // --- exportar a MP4 (lo hace el servidor con ffmpeg; aquí solo se eligen las opciones) ---
  $('export').onclick = () => { void openExport() }
  async function openExport() {
    await guardar()
    const f = store.project.format, short = Math.min(f.width, f.height)
    const dim = (s: number) => { const k = Math.min(s / short, 1); return `${Math.round(f.width * k / 2) * 2}×${Math.round(f.height * k / 2) * 2}` }
    const modal = document.createElement('div'); modal.className = 'modal'
    const box = document.createElement('div'); box.className = 'modal-box exp'; modal.append(box); document.body.append(modal)
    const close = () => { modal.remove() }
    const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    const mb = (n: number) => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`
    const prev = await fetch(`/api/proyectos/${slug}/exportaciones`).then(r => r.json()).catch(() => []) as { name: string; size: number; ruta: string }[]
    let carpeta = (await fetch('/api/configuracion').then(r => r.json()).catch(() => ({}))).carpetaExportacion as string | undefined ?? ''     // la última carpeta usada
    const corta = (r: string) => r.replace(/^\/Users\/[^/]+/, '~')

    const form = () => {
      box.innerHTML = `<h2>Exportar video</h2>
        <label>Nombre del archivo</label><input type="text" id="x-name" value="${esc(store.project.name)}" />
        <label>Guardar en</label>
        <div class="folder"><span id="x-folder" title="${esc(carpeta)}">${esc(corta(carpeta))}</span><button id="x-change">Cambiar…</button></div>
        <label>Resolución</label><select id="x-res"><option value="original">Original · ${f.width}×${f.height}</option><option value="720">720p · ${dim(720)}</option><option value="480">480p · ${dim(480)} (más liviano)</option></select>
        <label>Calidad</label><select id="x-cal"><option value="rapida">Rápida · se hace en menos tiempo</option><option value="buena" selected>Buena · recomendada</option><option value="maxima">Máxima · tarda más, archivo más grande</option></select>
        <p class="dim small">MP4 (H.264 + AAC) · ${f.fps} fps · ${tc(duration(store.project))} · incluye cortes, zooms, transiciones, superpuestos y música.</p>
        ${prev.length ? `<p class="dim small" style="margin-bottom:4px">Exportaciones anteriores (clic para mostrar en la carpeta)</p><div class="prev">${prev.map((p, i) => `<a href="#" data-i="${i}" title="${esc(p.ruta)}">${esc(p.name)} <i>${mb(p.size)}</i></a>`).join('')}</div>` : ''}
        <div class="row"><button id="x-no">Cancelar</button><button class="primary" id="x-go">Exportar</button></div>`
      box.querySelector<HTMLElement>('#x-no')!.onclick = close
      box.querySelector<HTMLElement>('#x-go')!.onclick = start
      box.querySelector<HTMLElement>('#x-change')!.onclick = async () => {        // diálogo del sistema para elegir la carpeta
        const b = box.querySelector<HTMLButtonElement>('#x-change')!; b.disabled = true; b.textContent = 'Elige en la ventana…'
        const r = await fetch('/api/carpeta', { method: 'POST', body: JSON.stringify({ actual: carpeta }), headers: { 'content-type': 'application/json' } }).then(r => r.json()).catch(() => ({}))
        if (r.carpeta) carpeta = r.carpeta
        const f = box.querySelector<HTMLElement>('#x-folder')!; f.textContent = corta(carpeta); f.title = carpeta
        b.disabled = false; b.textContent = 'Cambiar…'
      }
      box.querySelectorAll<HTMLAnchorElement>('.prev a').forEach(a => { a.onclick = e => { e.preventDefault(); void fetch(`/api/proyectos/${slug}/mostrar`, { method: 'POST', body: JSON.stringify({ ruta: prev[Number(a.dataset.i)].ruta }), headers: { 'content-type': 'application/json' } }) } })
    }
    const val = (id: string) => (box.querySelector(`#${id}`) as HTMLInputElement).value
    async function start() {
      const body = { nombre: val('x-name'), resolucion: val('x-res'), calidad: val('x-cal'), carpeta }
      box.innerHTML = '<h2>Exportando…</h2><p class="dim" id="x-det">Preparando…</p><div class="bar2"><i id="x-bar" style="width:0%"></i></div><div class="row"><button class="danger" id="x-cancel">Cancelar exportación</button></div>'
      let job = await fetch(`/api/proyectos/${slug}/exportar`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).then(r => r.json())
      if (job.error) { box.innerHTML = `<h2>No se pudo exportar</h2><p class="warn">${esc(job.error)}</p><div class="row"><button id="x-no">Cerrar</button></div>`; box.querySelector<HTMLElement>('#x-no')!.onclick = close; return }
      box.querySelector<HTMLElement>('#x-cancel')!.onclick = () => { void fetch(`/api/exportaciones/${encodeURIComponent(job.id)}/cancelar`, { method: 'POST' }) }
      while (job.status === 'running' && document.body.contains(modal)) {
        await new Promise(r => setTimeout(r, 600))
        job = await fetch(`/api/exportaciones/${encodeURIComponent(job.id)}`).then(r => r.json())
        const bar = box.querySelector<HTMLElement>('#x-bar'), det = box.querySelector<HTMLElement>('#x-det')
        if (bar) bar.style.width = `${Math.round(job.pct * 100)}%`
        if (det) det.textContent = `${job.detail ?? 'Renderizando…'} ${Math.round(job.pct * 100)}%`
      }
      if (job.status === 'done') {
        box.innerHTML = `<h2>✓ Video listo</h2><video src="/${job.url}" controls playsinline></video>
          <p class="dim small" title="${esc(job.file)}">Guardado en <b>${esc(corta(job.file))}</b> · ${mb(job.size)}</p>
          <div class="row"><button class="primary" id="x-show">Mostrar en la carpeta</button><button id="x-no">Cerrar</button></div>`
        box.querySelector<HTMLElement>('#x-no')!.onclick = close
        box.querySelector<HTMLElement>('#x-show')!.onclick = () => { void fetch(`/api/proyectos/${slug}/mostrar`, { method: 'POST', body: JSON.stringify({ ruta: job.file }), headers: { 'content-type': 'application/json' } }) }
      } else if (document.body.contains(modal)) {
        box.innerHTML = `<h2>${job.status === 'cancelado' ? 'Exportación cancelada' : 'No se pudo exportar'}</h2>${job.status === 'cancelado' ? '' : `<p class="warn">${esc(job.error ?? 'Error')}</p>`}<div class="row"><button id="x-back">Volver</button><button id="x-no">Cerrar</button></div>`
        box.querySelector<HTMLElement>('#x-no')!.onclick = close; box.querySelector<HTMLElement>('#x-back')!.onclick = form
      }
    }
    modal.onclick = e => { if (e.target === modal && !box.querySelector('#x-cancel')) close() }
    form()
  }

  // --- panel lateral como menú que entra desde la derecha (solo en pantallas angostas) ---
  const appEl = $('app'), setDrawer = (open: boolean) => appEl.classList.toggle('drawer-open', open)
  $('panelbtn').onclick = () => setDrawer(!appEl.classList.contains('drawer-open'))
  $('backdrop').onclick = () => setDrawer(false)
  window.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false) })

  // --- barra de herramientas ---------------------------------------------------
  const sel = () => store.selection
  $('play').onclick = () => player.toggle()
  // pantalla completa: solo el video (Esc para salir; Espacio, ←/→ y clic funcionan)
  const wrap = $('stage')      // pantalla completa de TODO el escenario: el video y, abajo, la barra de botones
  // Pantalla completa real del navegador; si el navegador no la permite (p. ej. el panel integrado), se simula cubriendo toda la ventana.
  const salirPantalla = () => { wrap.classList.remove('pseudo-fs'); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); player.pantalla = false; player.dirty = true; $('fullscreen').title = 'Pantalla completa (F)' }
  const pantallaCompleta = async () => {
    if (player.pantalla) { salirPantalla(); return }
    player.pantalla = true; player.dirty = true; $('fullscreen').title = 'Salir de pantalla completa (Esc)'
    // el panel integrado puede ignorar la pantalla completa real sin avisar: si en medio segundo no pasó, se simula
    try { await Promise.race([wrap.requestFullscreen(), new Promise<void>(r => setTimeout(r, 500))]) } catch { /* se simula abajo */ }
    if (!document.fullscreenElement && player.pantalla) wrap.classList.add('pseudo-fs')
  }
  $('fullscreen').onclick = () => { void pantallaCompleta() }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && player.pantalla && !wrap.classList.contains('pseudo-fs')) salirPantalla() })
  window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && player.pantalla) salirPantalla() })
  // inicio · atrás 5 s · play · más rápido · final
  const RATES = [1, 1.5, 2]
  const fmtRate = (r: number) => `${String(r).replace('.', ',')}×`
  const irA = (t: number) => { player.seek(t) }
  $('tostart').onclick = () => irA(0)
  $('nextclip').onclick = () => {      // siguiente clip; si ya está en el último, va al final
    const sig = layout(store.project).find(x => x.start > player.time() + 0.03)
    if (sig) irA(sig.start)
    else { const d = duration(store.project); if (player.playing) player.pause(); irA(Math.max(0, d - 0.04)) }
  }
  $('prevclip').onclick = () => {      // como en CapCut: si ya pasó medio segundo del clip, vuelve a SU inicio; si no, va al clip anterior
    const ant = [...layout(store.project)].reverse().find(x => x.start < player.time() - 0.5)
    irA(ant ? ant.start : 0)
  }
  $('toend').onclick = () => { const d = duration(store.project); if (player.playing) player.pause(); irA(Math.max(0, d - 0.04)) }
  $('fast').onclick = () => {
    const r = RATES[(RATES.indexOf(player.rate) + 1) % RATES.length]
    player.setRate(r); $('fastlab').textContent = fmtRate(r); $('fast').classList.toggle('on', r !== 1)
    if (!player.playing) void player.play()      // un toque = verlo ya a esa velocidad
  }
  $('undo').onclick = () => store.undo()
  $('redo').onclick = () => store.redo()
  /** Clip superpuesto (video o audio) seleccionado bajo el cabezal: S, Q y W actúan sobre él en vez de sobre la pista principal. */
  const ovSel = () => {
    const s = store.selection; if (s?.type !== 'overlay') return null
    const o = store.project.overlays?.find(x => x.id === s.id), t = player.playhead
    if (!o || store.project.tracks?.[(o.kind === 'video' ? 'v' : 'a') + o.track]?.locked) return null
    return t > o.start + 0.01 && t < overlayEnd(o) - 0.01 ? o : null
  }
  const splitHere = () => {
    const o = ovSel(); if (o) { exec(store, { op: 'split_overlay', id: o.id, at: player.playhead }); return }
    if (store.project.tracks?.main?.locked) { notify('La pista principal está bloqueada'); return } exec(store, { op: 'split', at: player.playhead })
  }
  $('split').onclick = splitHere
  /** Como CapCut: borra de un clip todo lo anterior (Q) o lo posterior (W) al cabezal y cierra el hueco. */
  const trimHere = (lado: 'antes' | 'despues') => {
    const o = ovSel(); if (o) { exec(store, { op: 'trim_overlay', id: o.id, lado, at: player.playhead }); return }      // superpuesto seleccionado: se recorta él
    if (store.project.tracks?.main?.locked) { notify('La pista principal está bloqueada'); return }
    const t = player.playhead, c = layout(store.project).find(x => t > x.start + 0.01 && t < x.end - 0.01)
    if (!c) { notify('Pon el cabezal dentro de un clip'); return }
    exec(store, lado === 'antes' ? { op: 'delete_range', from: c.start, to: t } : { op: 'delete_range', from: t, to: c.end })
    if (lado === 'antes') player.seek(c.start)
    store.select(null)
  }
  $('trimL').onclick = () => trimHere('antes')
  $('trimR').onclick = () => trimHere('despues')
  $('del').onclick = deleteSelected
  $('addsub').onclick = () => exec(store, { op: 'add_text', type: 'subtitle', start: player.playhead, end: player.playhead + 2.5, text: 'Nuevo subtítulo' })
  $('addgfx').onclick = () => exec(store, { op: 'add_text', type: 'graphic', start: player.playhead, end: player.playhead + 3, text: 'Nuevo gráfico' })
  $('zin').onclick = () => tl.zoom(1.4)
  $('zout').onclick = () => tl.zoom(1 / 1.4)
  $('zfit').onclick = () => tl.fit()
  const zoomR = $<HTMLInputElement>('zoomr')
  zoomR.oninput = () => { const target = 2 * Math.pow(300, Number(zoomR.value) / 100); tl.zoom(target / tl.pps) }

  function deleteSelected() {
    if (store.multi.length) {        // varios seleccionados: se borran todos juntos (una sola entrada de deshacer)
      const cmds: Cmd[] = [...store.multi.filter(m => m.type === 'overlay').map((m): Cmd => ({ op: 'delete_overlay', id: m.id })), ...store.multi.filter(m => m.type === 'clip').map((m): Cmd => ({ op: 'delete_clip', id: m.id })), ...(store.multi.some(m => m.type === 'music') ? [{ op: 'clear_music' } as Cmd] : [])]
      execBatch(store, cmds); store.select(null); return
    }
    const s = sel(); if (!s) return
    exec(store, s.type === 'clip' ? { op: 'delete_clip', id: s.id } : s.type === 'overlay' ? { op: 'delete_overlay', id: s.id } : s.type === 'music' ? { op: 'clear_music' } : { op: 'delete_layer', id: s.id })
    store.select(null)
  }

  window.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') { e.preventDefault(); player.toggle() }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void guardar(true) }
    else if (e.key === 's' && !mod) splitHere()
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); splitHere() }
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'q') { e.preventDefault(); trimHere('antes') }
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); trimHere('despues') }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected() }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo() }
    else if (e.key === 'Escape' && store.multi.length) store.select(null)
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'j') $('prevclip').click()
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'l') $('fast').click()
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'f') $('fullscreen').click()
    else if (e.key === 'Home') { e.preventDefault(); $('tostart').click() }
    else if (e.key === 'End') { e.preventDefault(); $('toend').click() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? player.seek(player.time() - 1 / 30) : $('prevclip').click() }     // ← clip anterior · Mayús+← un cuadro atrás
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? player.seek(player.time() + 1 / 30) : $('nextclip').click() }   // → clip siguiente · Mayús+→ un cuadro adelante
  })

  // --- arrastrar gráficos/subtítulos directamente sobre el video ---------------
  const cv = player.canvas
  const toVideo = (e: MouseEvent) => {
    const r = cv.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }
  // "Aplicar a todos": mover/cambiar un subtítulo lo cambia en todos (casilla del inspector, activada por defecto)
  const aplicarTodos = () => { try { return localStorage.getItem('gj.aplicarTodos') !== '0' } catch { return true } }
  type Gesto = { kind: 'mover' | 'escalar' | 'estirar' | 'girar'; id: string; m0: { x: number; y: number }; t0: TextLayer['transform']; F0: { x: number; y: number }; rot: number; i: number; movido: boolean }
  let gesto: Gesto | null = null
  const capaVisible = () => {
    const s = store.selection
    return s?.type === 'layer' ? visibleOverlays(store.project, player.time()).find(l => l.id === s.id) : undefined
  }
  cv.addEventListener('mousedown', e => {
    if (player.pantalla) { player.toggle(); return }      // a pantalla completa: tocar el video = play / pausa
    const m = toVideo(e), L = capaVisible()
    if (L) {
      const g = geomOf(player.ctx, L), a = hitAsa(g, m.x, m.y)
      if (a?.tipo === 'borrar') { deleteSelected(); return }
      if (a) {
        store.beginTx()
        gesto = { kind: a.tipo === 'girar' ? 'girar' : a.tipo === 'esquina' ? 'escalar' : 'estirar', id: L.id, m0: m, t0: transformEfectivo(g, L), F0: g.F, rot: g.rot, i: a.tipo === 'esquina' || a.tipo === 'lado' ? a.i : 0, movido: false }
        return
      }
    }
    const o = hitOverlay(player.ctx, store.project, player.time(), m.x, m.y)
    if (!o) { videoDown(m); return }
    store.select({ type: 'layer', id: o.id })
    store.beginTx()
    gesto = { kind: 'mover', id: o.id, m0: m, t0: transformEfectivo(geomOf(player.ctx, o), o), F0: geomOf(player.ctx, o).F, rot: 0, i: 0, movido: false }
  })
  // --- mover / agrandar / girar el VIDEO seleccionado (pista principal o superpuesto) ---------
  // Solo esquinas (tamaño, sin deformar) y asa de giro: un video no se estira por un lado.
  type GestoV = { kind: 'mover' | 'escalar' | 'girar'; sel: { type: 'clip' | 'overlay'; id: string }; m0: { x: number; y: number }; F0: { x: number; y: number }; s0: number; r0: number; x0: number; y0: number; movido: boolean }
  let gestoV: GestoV | null = null
  const dentro = (g: ReturnType<typeof player.videoGeom>, m: { x: number; y: number }) => { if (!g) return false; const q = aLocal(g.geom, m.x, m.y), b = g.geom.b; return q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h }
  function videoDown(m: { x: number; y: number }) {
    let V = player.videoGeom()
    const a = V ? hitAsa(V.geom, m.x, m.y) : null
    if (V && a && (a.tipo === 'esquina' || a.tipo === 'girar')) {
      store.beginTx()
      gestoV = { kind: a.tipo === 'girar' ? 'girar' : 'escalar', sel: { type: V.kind, id: V.id }, m0: m, F0: V.geom.F, s0: V.scale, r0: V.rotation, x0: V.x, y0: V.y, movido: false }
      return
    }
    if (!dentro(V, m)) {      // tocar el video sin tener su caja = seleccionar el clip que se ve ahora; fuera del video = quitar la selección
      const loc = locate(store.project, player.time()), prev = store.selection
      if (!loc || store.project.tracks?.main?.hidden) { store.select(null); return }
      const cl = loc.placed.clip
      store.select({ type: 'clip', id: cl.id }); V = player.videoGeom()
      if (!V || !dentro(V, m)) { if (prev) store.select(null); return }
    }
    store.beginTx()
    gestoV = { kind: 'mover', sel: { type: V!.kind, id: V!.id }, m0: m, F0: V!.geom.F, s0: V!.scale, r0: V!.rotation, x0: V!.x, y0: V!.y, movido: false }
  }
  window.addEventListener('mousemove', e => {
    if (!gestoV) return
    const G = gestoV, m = toVideo(e)
    if (!G.movido && Math.hypot(m.x - G.m0.x, m.y - G.m0.y) < 2) return
    G.movido = true
    const nt: Partial<{ x: number; y: number; scale: number; rotation: number }> = {}
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
    if (G.kind === 'mover') {
      let cx = G.F0.x + (m.x - G.m0.x), cy = G.F0.y + (m.y - G.m0.y)
      const thr = 8 * (W / cv.getBoundingClientRect().width)
      guias.x = guias.y = false
      if (!e.altKey) {      // imán al centro (Alt lo desactiva)
        if (Math.abs(cx - W / 2) < thr) { cx = W / 2; guias.x = true }
        if (Math.abs(cy - H / 2) < thr) { cy = H / 2; guias.y = true }
      }
      nt.x = cx / W; nt.y = cy / H
    } else if (G.kind === 'escalar') nt.scale = clamp(G.s0 * (Math.hypot(m.x - G.F0.x, m.y - G.F0.y) / Math.max(Math.hypot(G.m0.x - G.F0.x, G.m0.y - G.F0.y), 8)), 0.1, 8)
    else {
      let r = G.r0 + ((Math.atan2(m.y - G.F0.y, m.x - G.F0.x) - Math.atan2(G.m0.y - G.F0.y, G.m0.x - G.F0.x)) * 180) / Math.PI
      r = ((r + 180) % 360 + 360) % 360 - 180
      const q = Math.round(r / 45) * 45; if (Math.abs(r - q) < 3) r = q                      // se pega a 0°, 45°, 90°…
      nt.rotation = r
    }
    store.live(p => {
      if (G.sel.type === 'clip') { const c = p.clips.find(q => q.id === G.sel.id); if (c) c.transform = { ...CLIP_TRANSFORM_DEFAULT, ...c.transform, ...nt } }
      else { const o = p.overlays?.find(q => q.id === G.sel.id); if (o) o.transform = { ...o.transform, ...nt } }
    })
    player.dirty = true
  })
  window.addEventListener('mouseup', () => { if (gestoV) { store.endTx(); gestoV = null; guias.x = guias.y = false; player.dirty = true } })
  const CURSOR = ['ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'], CURSOR_ESQ = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize']
  cv.addEventListener('mousemove', e => {
    if (gesto || gestoV) return
    const m = toVideo(e), L = capaVisible(), a = L ? hitAsa(geomOf(player.ctx, L), m.x, m.y) : null
    const V = !L ? player.videoGeom() : null, av = V ? hitAsa(V.geom, m.x, m.y) : null
    if (V) { cv.style.cursor = av?.tipo === 'girar' ? 'grab' : av?.tipo === 'esquina' ? CURSOR_ESQ[av.i] : dentro(V, m) ? 'move' : 'default'; return }
    cv.style.cursor = a ? (a.tipo === 'borrar' ? 'pointer' : a.tipo === 'girar' ? 'grab' : a.tipo === 'esquina' ? CURSOR_ESQ[a.i] : a.tipo === 'lado' ? CURSOR[a.i] : 'default') : hitOverlay(player.ctx, store.project, player.time(), m.x, m.y) ? 'move' : 'default'
  })
  window.addEventListener('mousemove', e => {
    if (!gesto) return
    const m = toVideo(e), G = gesto, t0 = G.t0
    if (!G.movido && Math.hypot(m.x - G.m0.x, m.y - G.m0.y) < 2) return
    G.movido = true
    const nt: Partial<TextLayer['transform']> = {}
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
    if (G.kind === 'mover') {
      // imán al centro de la pantalla (Alt lo desactiva): el centro del elemento se pega a la mitad y se muestra la guía
      let cx = G.F0.x + (m.x - G.m0.x), cy = G.F0.y + (m.y - G.m0.y)
      const thr = 8 * (W / cv.getBoundingClientRect().width)
      guias.x = guias.y = false
      if (!e.altKey) {
        if (Math.abs(cx - W / 2) < thr) { cx = W / 2; guias.x = true }
        if (Math.abs(cy - H / 2) < thr) { cy = H / 2; guias.y = true }
      }
      nt.x = clamp(t0.x + (cx - G.F0.x) / W, 0, 1); nt.y = clamp(t0.y + (cy - G.F0.y) / H, 0, 1)
    }
    else if (G.kind === 'escalar') nt.scale = clamp(t0.scale * (Math.hypot(m.x - G.F0.x, m.y - G.F0.y) / Math.max(Math.hypot(G.m0.x - G.F0.x, G.m0.y - G.F0.y), 8)), 0.1, 6)
    else if (G.kind === 'estirar') {
      const c = Math.cos(-G.rot), s = Math.sin(-G.rot), loc = (p: { x: number; y: number }) => ({ x: (p.x - G.F0.x) * c - (p.y - G.F0.y) * s, y: (p.x - G.F0.x) * s + (p.y - G.F0.y) * c })
      const a = loc(m), a0 = loc(G.m0)
      if (G.i % 2) nt.sx = clamp((t0.sx ?? 1) * (Math.abs(a.x) / Math.max(Math.abs(a0.x), 8)), 0.15, 8)
      else nt.sy = clamp((t0.sy ?? 1) * (Math.abs(a.y) / Math.max(Math.abs(a0.y), 8)), 0.15, 8)
    } else {
      let r = (t0.rotation || 0) + ((Math.atan2(m.y - G.F0.y, m.x - G.F0.x) - Math.atan2(G.m0.y - G.F0.y, G.m0.x - G.F0.x)) * 180) / Math.PI
      r = ((r + 180) % 360 + 360) % 360 - 180
      const q = Math.round(r / 45) * 45; if (Math.abs(r - q) < 3) r = q                      // se pega a 0°, 45°, 90°…
      nt.rotation = r
    }
    store.live(p => {
      const l = p.layers.find(q => q.id === G.id) as TextLayer | undefined; if (!l) return
      const objetivos = l.type === 'subtitle' && aplicarTodos() ? (p.layers.filter(q => q.type === 'subtitle') as TextLayer[]) : [l]
      l.transform = { ...t0, ...nt }
      for (const q of objetivos) if (q !== l) q.transform = { ...l.transform }
    })
    player.dirty = true
  })
  window.addEventListener('mouseup', () => { if (gesto) { store.endTx(); gesto = null; guias.x = guias.y = false; player.dirty = true } })

  // --- menú de transición al tocar un corte entre dos clips ---------------------------------
  let cutMenu: HTMLElement | null = null
  const closeCutMenu = () => { cutMenu?.remove(); cutMenu = null }
  tl.onCutClick = (clipId, cx, cy) => {
    closeCutMenu()
    const clip = store.project.clips.find(c => c.id === clipId); if (!clip) return
    const m = document.createElement('div'); m.className = 'cutmenu'
    const opts: { label: string; kind: TransitionKind; dir?: 1 | -1 }[] = [
      { label: 'Deslizar · entra desde la derecha', kind: 'slide', dir: -1 },
      { label: 'Deslizar · entra desde la izquierda', kind: 'slide', dir: 1 },
      { label: 'Destello', kind: 'flash' },
      { label: 'Fundido a negro', kind: 'dip' },
    ]
    const cur = clip.transition
    m.innerHTML = `<h4>Transición en el corte</h4>`
    for (const o of opts) {
      const b = document.createElement('button'); b.textContent = o.label
      if (cur?.kind === o.kind && (o.dir === undefined || cur.dir === o.dir)) b.classList.add('on')
      b.onclick = () => {
        exec(store, { op: 'set_transition', clip: clipId, transition: { kind: o.kind, ...TRANSITION_DEFAULTS[o.kind], dir: o.dir } })
        closeCutMenu()
        const pl = layout(store.project).find(x => x.clip.id === clipId)   // muestra el resultado un instante
        if (pl) { player.seek(Math.max(0, pl.start - 0.6)); void player.play(); setTimeout(() => { if (player.playing && player.time() < pl.start + 1.2) player.pause() }, 1800) }
      }
      m.append(b)
    }
    if (cur) { const b = document.createElement('button'); b.textContent = 'Quitar transición'; b.className = 'danger'; b.onclick = () => { exec(store, { op: 'set_transition', clip: clipId, transition: null }); closeCutMenu() }; m.append(b) }
    m.insertAdjacentHTML('beforeend', '<p class="hint">Duración e intensidad: selecciona uno de los dos clips.</p>')
    document.body.append(m); cutMenu = m
    const w = m.offsetWidth, h = m.offsetHeight
    m.style.left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8) + 'px'
    m.style.top = Math.max(8, cy - h - 8) + 'px'
  }
  // --- esquinas de un clip superpuesto: transición (video) o fundido del audio (audio) ---------------------------
  tl.onOverlayCorner = (id, lado, cx, cy) => {
    closeCutMenu()
    const o = store.project.overlays?.find(x => x.id === id); if (!o) return
    const m = document.createElement('div'); m.className = 'cutmenu'
    const boton = (label: string, on: boolean, fn: () => void, danger = false) => {
      const b = document.createElement('button'); b.textContent = label; if (on) b.classList.add('on'); if (danger) b.className = 'danger'
      b.onclick = () => { fn(); closeCutMenu() }; m.append(b)
    }
    if (o.kind === 'video') {
      m.innerHTML = '<h4>Transición de la toma</h4>'
      const opts: [string, 'fundido' | 'subir' | '3d'][] = [['Fundido', 'fundido'], ['Subir (flota hacia arriba)', 'subir'], ...(o.mascara ? [['Giro 3D (card)', '3d'] as [string, '3d']] : [])]
      for (const [label, k] of opts) boton(label, o.transicion === k, () => exec(store, { op: 'update_overlay', id, patch: { transicion: k } }))
      if (o.transicion) boton('Quitar transición', false, () => exec(store, { op: 'update_overlay', id, patch: { transicion: null } }), true)
      m.insertAdjacentHTML('beforeend', '<p class="hint">La misma transición se usa al entrar y al salir de la toma.</p>')
    } else {
      const actual = o.fundido?.[lado] ?? 0
      m.innerHTML = `<h4>Fundido de ${lado === 'entrada' ? 'entrada' : 'salida'} del audio</h4>`
      for (const d of [0.5, 1, 2, 3]) boton(`${String(d).replace('.', ',')} s`, Math.abs(actual - d) < 0.01, () => exec(store, { op: 'update_overlay', id, patch: { fundido: { [lado]: d } } }))
      if (actual) boton('Sin fundido', false, () => exec(store, { op: 'update_overlay', id, patch: { fundido: { [lado]: 0 } } }), true)
    }
    document.body.append(m); cutMenu = m
    const w = m.offsetWidth, h = m.offsetHeight
    m.style.left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8) + 'px'
    m.style.top = Math.max(8, cy - h - 8) + 'px'
  }
  // --- relación de aspecto del video (formato del proyecto) ---------------------------------
  const FORMATOS: [string, string, number, number][] = [['9:16', 'Vertical · TikTok, Reels, Shorts', 1080, 1920], ['16:9', 'Horizontal · YouTube', 1920, 1080], ['1:1', 'Cuadrado', 1080, 1080], ['4:5', 'Vertical · Instagram', 1080, 1350], ['4:3', 'Horizontal clásico', 1440, 1080]]
  const aspectBtn = $('aspect')
  const etiquetaFormato = () => { const f = store.project.format, r = f.width / f.height; return FORMATOS.find(x => Math.abs(x[2] / x[3] - r) < 0.01)?.[0] ?? `${f.width}×${f.height}` }
  const updAspect = () => { aspectBtn.textContent = etiquetaFormato() }
  updAspect()
  aspectBtn.onclick = () => {
    if (cutMenu?.dataset.aspect) { closeCutMenu(); return }
    closeCutMenu()
    const m = document.createElement('div'); m.className = 'cutmenu'; m.dataset.aspect = '1'
    m.innerHTML = '<h4>Relación de aspecto</h4>'
    const f = store.project.format
    const poner = (w: number, h: number) => { exec(store, { op: 'set_format', width: w, height: h }); closeCutMenu() }
    for (const [lab, desc, w, h] of FORMATOS) {
      const b = document.createElement('button'); b.innerHTML = `<b>${lab}</b> · ${desc}`
      if (Math.abs(f.width / f.height - w / h) < 0.01) b.classList.add('on')
      b.onclick = () => poner(Math.abs(f.width / f.height - w / h) < 0.01 ? f.width : w, Math.abs(f.width / f.height - w / h) < 0.01 ? f.height : h)
      m.append(b)
    }
    const v = store.project.assets.find(a => a.kind !== 'audio' && a.width > 0 && a.height > 0)
    if (v) { const o = formatoDe(v.width, v.height, f.fps), b = document.createElement('button'); b.textContent = `Igual que el video (${o.width}×${o.height})`; b.onclick = () => poner(o.width, o.height); m.append(b) }
    m.insertAdjacentHTML('beforeend', '<p class="hint">El video no se deforma nunca: se ajusta dentro del cuadro. Para llenarlo, selecciónalo y agrándalo.</p>')
    ;(document.fullscreenElement ?? document.body).append(m); cutMenu = m
    const r = aspectBtn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight
    m.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8) + 'px'
    m.style.top = Math.max(8, r.top - h - 8) + 'px'
  }
  window.addEventListener('mousedown', e => { if (cutMenu && !cutMenu.contains(e.target as Node) && e.target !== aspectBtn) closeCutMenu() }, true)
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeCutMenu() })

  // --- inspector -----------------------------------------------------------------
  const insp = $('inspector')
  let lastKey = ''
  function field(label: string, el: HTMLElement) {
    const l = document.createElement('label'); l.textContent = label
    insp.append(l, el)
  }
  /** Los setters reciben el proyecto ACTUAL (no una referencia vieja), así sobreviven a deshacer/rehacer. */
  function input(type: string, value: string | number, set: (p: Project, v: string) => void, attrs: Record<string, string> = {}) {
    const el = document.createElement('input'); el.type = type
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v))
    el.value = String(value)      // el valor va DESPUÉS de min/max/step: si no, un deslizador 0–1 redondea 0,22 a 0
    el.addEventListener('focus', () => store.beginTx())
    el.addEventListener('blur', () => store.endTx())
    el.addEventListener('input', () => store.live(p => set(p, el.value)))
    return el
  }
  /** Pestaña "Subtítulos": todos los subtítulos en filas (tiempo + texto) para corregirlos en un solo lugar. */
  function buildSubtitleList(selId: string) {
    const subs = store.project.layers.filter((l): l is Extract<TextLayer, { type: 'subtitle' }> => l.type === 'subtitle').sort((a, b) => a.start - b.start)
    const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
    insp.insertAdjacentHTML('beforeend', `<div class="sublist-head"><span>${subs.length} subtítulos</span><span class="dim">Enter pasa al siguiente</span></div><div class="sublist"></div>`)
    const box = insp.querySelector('.sublist') as HTMLElement
    subs.forEach(l => {
      const row = document.createElement('div'); row.className = 'subrow' + (l.id === selId ? ' on' : ''); row.dataset.id = l.id
      const tm = document.createElement('button'); tm.className = 'subtime'; tm.textContent = fmt(l.start); tm.title = 'Ir a este subtítulo'
      tm.onclick = () => { player.seek(l.start + 0.01); store.select({ type: 'layer', id: l.id }) }
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'subtxt'; inp.value = l.text; inp.spellcheck = false
      inp.addEventListener('focus', () => { store.beginTx(); player.seek(l.start + 0.01) })
      inp.addEventListener('blur', () => store.endTx())
      inp.addEventListener('input', () => store.live(p => { const q = p.layers.find(o => o.id === l.id) as TextLayer | undefined; if (q) { q.text = inp.value; sincronizarPalabras(q) } }))
      // al salir de la fila se reconstruye la lista (cambió el texto): por eso el foco se pone DESPUÉS, buscando la fila por su id
      const irA = (r: Element | null) => { const id = (r as HTMLElement | null)?.dataset.id; if (id) setTimeout(() => (insp.querySelector(`.subrow[data-id="${id}"] .subtxt`) as HTMLInputElement | null)?.focus(), 0) }
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); irA(row.nextElementSibling); inp.blur() }
        else if (e.key === 'ArrowDown' && inp.selectionStart === inp.value.length) { e.preventDefault(); irA(row.nextElementSibling); inp.blur() }
        else if (e.key === 'ArrowUp' && inp.selectionStart === 0) { e.preventDefault(); irA(row.previousElementSibling); inp.blur() }
        e.stopPropagation()
      })
      const del = document.createElement('button'); del.className = 'x subdel'; del.textContent = '✕'; del.title = 'Borrar este subtítulo'
      del.onclick = () => { exec(store, { op: 'delete_layer', id: l.id }); const next = subs.find(o => o.id !== l.id && o.start >= l.start) ?? subs.find(o => o.id !== l.id); store.select(next ? { type: 'layer', id: next.id } : null) }
      row.append(tm, inp, del); box.append(row)
    })
    box.querySelector('.subrow.on')?.scrollIntoView({ block: 'center' })
  }
  let subTab: 'ajustes' | 'lista' = 'ajustes'
  /** Panel de varios elementos seleccionados: solo lo que tienen en común (volumen, velocidad, color si todos son clips, borrar). */
  function renderMulti() {
    const p = store.project
    const clips = store.multi.filter(m => m.type === 'clip').map(m => p.clips.find(c => c.id === m.id)).filter((c): c is NonNullable<typeof c> => !!c)
    const ovs = store.multi.filter(m => m.type === 'overlay').map(m => p.overlays?.find(o => o.id === m.id)).filter((o): o is NonNullable<typeof o> => !!o)
    const music = store.multi.some(m => m.type === 'music') && p.music ? p.music : undefined
    const n = clips.length + ovs.length + (music ? 1 : 0)
    if (n !== store.multi.length) { store.selectMany([...clips.map(c => ({ type: 'clip' as const, id: c.id })), ...ovs.map(o => ({ type: 'overlay' as const, id: o.id })), ...(music ? [{ type: 'music' as const, id: 'music' }] : [])]); return }     // algo seleccionado ya no existe
    const vols = [...clips.map(c => c.volume), ...ovs.filter(o => o.kind === 'audio' || o.volume !== undefined).map(o => o.volume), ...(music ? [music.volume] : [])]
    const speeds = [...clips.map(c => c.speed), ...ovs.map(o => o.speed)]
    const key = `multi:${store.multi.map(m => m.id).join(',')}:${vols.map(v => Math.round(v * 100)).join(',')}:${speeds.join(',')}:${clips.map(c => c.color ? `${c.color.brillo}/${c.color.contraste}/${c.color.saturacion}` : '').join(',')}`
    if (key === lastKey) return
    if (lastKey.startsWith('multi:' + store.multi.map(m => m.id).join(',') + ':') && insp.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return     // moviendo un deslizador de aquí
    lastKey = key; insp.innerHTML = ''
    const nVid = clips.length + ovs.filter(o => o.kind === 'video').length, nAud = ovs.filter(o => o.kind === 'audio').length
    const partes = [nVid ? `${nVid} de video` : '', nAud ? `${nAud} de audio` : '', music ? 'música' : ''].filter(Boolean).join(' · ')
    insp.insertAdjacentHTML('beforeend', `<h3>${n} seleccionados</h3><p class="hint" style="margin:0 0 6px">${partes}. Lo que cambies aquí se aplica a todos.</p>`)
    const section = (title: string) => insp.insertAdjacentHTML('beforeend', `<h3 class="sec">${title}</h3>`)
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
    const same = (a: number[]) => a.every(v => Math.abs(v - a[0]) < 0.001)
    const ids = { clips: clips.map(c => c.id), ovs: ovs.map(o => o.id) }
    const each = (pr: Project, fn: (x: { volume: number }) => void) => { for (const id of ids.clips) { const c = pr.clips.find(q => q.id === id); if (c) fn(c) } for (const id of ids.ovs) { const o = pr.overlays?.find(q => q.id === id); if (o) fn(o) } if (music && pr.music) fn(pr.music) }
    // ---- VOLUMEN ----
    section('Volumen')
    const lv = document.createElement('label'); lv.innerHTML = `Volumen <span class="val">${same(vols) ? Math.round(vols[0] * 100) + ' %' : 'distintos'}</span>`
    const sv = input('range', Math.min(2, avg(vols)), (pr, v) => each(pr, x => { x.volume = Math.round(parseFloat(v) * 1000) / 1000 }), { min: '0', max: '2', step: '0.01' })
    sv.addEventListener('input', () => { lv.querySelector('.val')!.textContent = Math.round(parseFloat(sv.value) * 100) + ' %' })
    insp.append(lv, sv)
    const rowV = document.createElement('div'); rowV.style.cssText = 'display:flex;gap:6px;margin:4px 0'
    for (const db of [-3, -1, 1, 3]) {
      const b = document.createElement('button'); b.textContent = `${db > 0 ? '+' : ''}${db} dB`; b.title = 'Sube o baja el volumen de todos los seleccionados'
      b.onclick = () => store.mutate(pr => each(pr, x => { x.volume = Math.min(4, Math.max(0, Math.round(x.volume * Math.pow(10, db / 20) * 1000) / 1000)) }))
      rowV.append(b)
    }
    insp.append(rowV)
    // ---- VELOCIDAD (clips y superpuestos; la música no) ----
    if (speeds.length) {
      section('Velocidad')
      const sp = document.createElement('input'); sp.type = 'number'; sp.step = '0.05'; sp.min = '0.1'; sp.max = '8'
      sp.value = same(speeds) ? String(speeds[0]) : ''; sp.placeholder = 'varias'
      const lab = document.createElement('label'); lab.textContent = 'Velocidad (×)'
      sp.onchange = () => { const v = parseFloat(sp.value); if (v > 0) execBatch(store, [...ids.clips.map((id): Cmd => ({ op: 'speed', clip: id, value: v })), ...ids.ovs.map((id): Cmd => ({ op: 'update_overlay', id, patch: { speed: v } }))]) }
      insp.append(lab, sp)
      const rowS = document.createElement('div'); rowS.style.cssText = 'display:flex;gap:6px;margin:4px 0;flex-wrap:wrap'
      for (const v of [0.5, 0.75, 1, 1.25, 1.5, 2]) { const b = document.createElement('button'); b.textContent = `${String(v).replace('.', ',')}×`; b.onclick = () => { sp.value = String(v); sp.onchange!(new Event('change')) }; rowS.append(b) }
      insp.append(rowS)
      if (ids.clips.length) insp.insertAdjacentHTML('beforeend', '<p class="hint">En los clips de la pista principal el video se acorta o alarga y lo de después se corre.</p>')
    }
    // ---- LUCES Y COLOR (solo si todos son clips de la pista principal) ----
    if (clips.length && !ovs.length && !music) {
      section('Luces y color')
      const K = (c: typeof clips[number]) => ({ ...CLIP_COLOR_DEFAULT, ...c.color })
      const setAll = (pr: Project, patch: Partial<typeof CLIP_COLOR_DEFAULT>) => { for (const id of ids.clips) { const c = pr.clips.find(q => q.id === id); if (c) c.color = { ...CLIP_COLOR_DEFAULT, ...c.color, ...patch } } }
      const mk = (label: string, k: 'brillo' | 'contraste' | 'saturacion', lo: number, hi: number) => {
        const l = document.createElement('label'); const vs = clips.map(c => K(c)[k]); l.innerHTML = `${label} <span class="val">${same(vs) ? Math.round(vs[0] * 100) + ' %' : 'distintos'}</span>`
        const el = input('range', avg(vs), (pr, v) => setAll(pr, { [k]: parseFloat(v) }), { min: String(lo), max: String(hi), step: '0.01' })
        el.addEventListener('input', () => { l.querySelector('.val')!.textContent = Math.round(parseFloat(el.value) * 100) + ' %' })
        insp.append(l, el)
      }
      mk('Brillo', 'brillo', 0.5, 1.8); mk('Contraste', 'contraste', 0.6, 1.6); mk('Saturación', 'saturacion', 0, 2)
      const bq = document.createElement('button'); bq.textContent = 'Quitar corrección de color'; bq.style.margin = '4px 0'
      bq.onclick = () => execBatch(store, ids.clips.map((id): Cmd => ({ op: 'set_clip_color', clip: id, color: null }))); insp.append(bq)
    }
    // ---- borrar / soltar ----
    const bd = document.createElement('button'); bd.textContent = `Borrar los ${n} seleccionados`; bd.className = 'danger'; bd.style.marginTop = '14px'; bd.onclick = deleteSelected
    const bs = document.createElement('button'); bs.textContent = 'Quitar la selección'; bs.style.marginTop = '6px'; bs.onclick = () => store.select(null)
    insp.append(bd, bs)
    insp.insertAdjacentHTML('beforeend', '<p class="hint dimmer">Seleccionar varios: arrastra un cuadro sobre la línea de tiempo · Mayús + clic = todo lo que hay entre dos · ⌘ + clic = suma o quita uno.</p>')
  }

  function renderInspector() {
    if (store.multi.length) { renderMulti(); return }
    const s = sel()
    const p = store.project
    const clip = s?.type === 'clip' ? p.clips.find(c => c.id === s.id) : undefined
    const lay = s?.type === 'layer' ? p.layers.find(o => o.id === s.id) : undefined
    const ov = s?.type === 'overlay' ? p.overlays?.find(o => o.id === s.id) : undefined
    if (s && !(clip || lay || ov || (s.type === 'music' && p.music))) { store.selection = null; renderInspector(); return }     // lo seleccionado ya no existe (p. ej. tras deshacer)
    const nextClip = clip ? p.clips[p.clips.indexOf(clip) + 1] : undefined
    const key = s ? `${s.type}:${s.id}:${clip?.zoom?.kind ?? ''}:${clip?.transition?.kind ?? ''}:${clip?.transition?.dir ?? ''}:${nextClip?.transition?.kind ?? ''}:${nextClip?.transition?.dir ?? ''}` : 'none'
    const esSub = lay?.type === 'subtitle'
    const listaSig = esSub && subTab === 'lista' ? p.layers.filter(l => l.type === 'subtitle').map(l => l.id + '\u0001' + l.text).join('\u0002') : ''
    if (esSub && subTab === 'lista' && lastKey.startsWith(`layer:${s!.id}:`) && insp.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains('subtxt')) return   // no pisar lo que se está escribiendo
    const tk = clip ? [clip.transform?.x, clip.transform?.y, clip.transform?.scale, clip.transform?.rotation].map(v => v === undefined ? '' : Math.round(v * 100)).join(',') : ''
    const ck = clip?.color ? `c${Math.round(clip.color.brillo * 100)},${Math.round(clip.color.contraste * 100)},${Math.round(clip.color.saturacion * 100)}` : ''
    const keyFull = key + (esSub ? `:${subTab}:${listaSig}` : '') + (clip ? `:t${tk}:${ck}` : '')
    if (keyFull === lastKey && key !== 'none') return
    if (clip && lastKey.startsWith(`clip:${s!.id}:`) && insp.contains(document.activeElement) && /^(INPUT)$/.test((document.activeElement as HTMLElement).tagName) && lastKey.replace(/:t[^:]*:c?[^:]*$/, '') === keyFull.replace(/:t[^:]*:c?[^:]*$/, '')) return   // moviendo un deslizador de aquí: no reconstruir el panel
    if (lastKey.startsWith('overlay') && key.startsWith('overlay') && insp.contains(document.activeElement)) return   // no pisar lo que se está escribiendo
    if (key === 'none' && lastKey === 'none') { updatePool(); return }
    lastKey = keyFull
    insp.innerHTML = ''
    if (clip) {
      const id = clip.id
      const C = (pr: Project) => pr.clips.find(c => c.id === id)!
      insp.insertAdjacentHTML('beforeend', `<h3>Clip ${id}</h3>`)
      const idx = p.clips.indexOf(clip), prevClip = p.clips[idx - 1]
      const section = (title: string) => insp.insertAdjacentHTML('beforeend', `<h3 class="sec">${title}</h3>`)
      const select = (opts: [string, string][], value: string, onchange: (v: string) => void) => {
        const el = document.createElement('select'); el.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); el.value = value; el.onchange = () => onchange(el.value); return el
      }
      /** Deslizador con el valor a la vista (se edita en vivo y es UNA entrada de deshacer). */
      const slider = (label: string, value: number, min: number, max: number, step: number, fmt: (n: number) => string, set: (pr: Project, n: number) => void) => {
        const l = document.createElement('label'); l.innerHTML = `${label} <span class="val">${fmt(value)}</span>`
        const el = input('range', value, (pr, v) => set(pr, parseFloat(v)), { min: String(min), max: String(max), step: String(step) })
        el.addEventListener('input', () => { l.querySelector('.val')!.textContent = fmt(parseFloat(el.value)) })
        insp.append(l, el)
      }
      const pct = (n: number) => `${Math.round(n * 100)} %`, sec = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, '')} s`

      // ---- POSICIÓN Y TAMAÑO del video (se mueve, agranda y gira SIN deformarlo; también con las asas sobre el video) ----
      section('Posición y tamaño')
      const T = (pr: Project) => ({ ...CLIP_TRANSFORM_DEFAULT, ...C(pr).transform })
      const setT = (pr: Project, patch: Partial<typeof CLIP_TRANSFORM_DEFAULT>) => { C(pr).transform = { ...T(pr), ...patch } }
      const tf = { ...CLIP_TRANSFORM_DEFAULT, ...clip.transform }
      slider('Tamaño', tf.scale, 0.1, 4, 0.01, pct, (pr, n) => setT(pr, { scale: n }))
      slider('Giro', tf.rotation, -180, 180, 1, n => `${Math.round(n)}°`, (pr, n) => setT(pr, { rotation: n }))
      slider('Posición horizontal', tf.x, -0.5, 1.5, 0.01, pct, (pr, n) => setT(pr, { x: n }))
      slider('Posición vertical', tf.y, -0.5, 1.5, 0.01, pct, (pr, n) => setT(pr, { y: n }))
      const rowT = document.createElement('div'); rowT.className = 'row'; rowT.style.cssText = 'display:flex;gap:6px;margin:6px 0 2px'
      const bFit = document.createElement('button'); bFit.textContent = 'Ajustar al cuadro'; bFit.title = 'El video entero dentro del cuadro, centrado y sin giro'
      bFit.onclick = () => exec(store, { op: 'set_clip_transform', clip: id, transform: null })
      const bFill = document.createElement('button'); bFill.textContent = 'Llenar el cuadro'; bFill.title = 'Agranda el video hasta cubrir todo el cuadro (recorta lo que sobra, sin deformar)'
      bFill.onclick = () => { const cover = (() => { const a = store.asset(clip.assetId); const fw = a?.width || 16, fh = a?.height || 9, k = Math.min(W / fw, H / fh); return Math.max(W / (fw * k), H / (fh * k)) })(); exec(store, { op: 'set_clip_transform', clip: id, transform: { x: 0.5, y: 0.5, rotation: 0, scale: Math.round(cover * 1000) / 1000 } }) }
      rowT.append(bFit, bFill); insp.append(rowT)
      insp.insertAdjacentHTML('beforeend', '<p class="hint">También: toca el video y arrastra para moverlo, las esquinas para agrandarlo y el círculo de abajo para girarlo. La forma del video nunca se deforma.</p>')

      // ---- LUCES Y COLOR del clip (brillo → contraste → saturación) ----
      section('Luces y color')
      const KC = { ...CLIP_COLOR_DEFAULT, ...clip.color }
      const setK = (pr: Project, patch: Partial<typeof CLIP_COLOR_DEFAULT>) => { C(pr).color = { ...CLIP_COLOR_DEFAULT, ...C(pr).color, ...patch } }
      slider('Brillo', KC.brillo, 0.5, 1.8, 0.01, pct, (pr, n) => setK(pr, { brillo: n }))
      slider('Contraste', KC.contraste, 0.6, 1.6, 0.01, pct, (pr, n) => setK(pr, { contraste: n }))
      slider('Saturación', KC.saturacion, 0, 2, 0.01, pct, (pr, n) => setK(pr, { saturacion: n }))
      const bK = document.createElement('button'); bK.textContent = 'Quitar corrección de color'; bK.style.margin = '4px 0'
      bK.onclick = () => exec(store, { op: 'set_clip_color', clip: id, color: null })
      insp.append(bK)

      // ---- EFECTO (por ahora el único efecto es el Zoom; aquí irán los demás) ----
      section('Efecto')
      field('Efecto', select([['', 'Ninguno'], ['zoom', 'Zoom']], clip.zoom ? 'zoom' : '', v =>
        exec(store, { op: 'set_zoom', clip: id, zoom: v === 'zoom' ? { kind: 'push', ...ZOOM_DEFAULTS.push } : null })))
      if (clip.zoom) {
        const zk = clip.zoom.kind
        field('Tipo de zoom', select([['push', 'Acercar (lento)'], ['pull', 'Alejar (lento)'], ['punch', 'Golpe de zoom'], ['temblor', 'Temblor de cámara'], ['glitch', 'Glitch RGB']], zk, v => {
          const k = v as ZoomKind, keep = ['push', 'pull'].includes(zk) && ['push', 'pull'].includes(k) ? clip.zoom!.amount : ZOOM_DEFAULTS[k].amount     // al pasar entre acercar/alejar se conserva la intensidad
          exec(store, { op: 'set_zoom', clip: id, zoom: { kind: k, amount: keep, duration: ZOOM_DEFAULTS[k].duration } })
        }))
        insp.insertAdjacentHTML('beforeend', `<p class="hint">${ZOOM_INFO[zk].hint}</p>`)
        slider('Intensidad', clip.zoom.amount, 0.05, 0.5, 0.01, pct, (pr, n) => { const z = C(pr).zoom; if (z) z.amount = n })
        if (zk === 'punch' || zk === 'glitch') slider('Duración del golpe', clip.zoom.duration ?? 0.35, 0.1, 1, 0.05, sec, (pr, n) => { const z = C(pr).zoom; if (z) z.duration = n })
      }

      // ---- TRANSICIONES: la del corte es UNA sola; aquí se ve como entrada de este clip y como salida del anterior ----
      const transitionSection = (title: string, owner: typeof clip | undefined, note: string) => {
        section(title)
        if (!owner) { insp.insertAdjacentHTML('beforeend', `<p class="hint">${note}</p>`); return }
        const oid = owner.id, tr = owner.transition
        const O = (pr: Project) => pr.clips.find(c => c.id === oid)!
        field('Tipo', select([['', 'Ninguna'], ...TRANSITION_KINDS.map((k): [string, string] => [k, TRANSITION_INFO[k].name])], tr?.kind ?? '', v =>
          exec(store, { op: 'set_transition', clip: oid, transition: v ? { kind: v as TransitionKind, ...TRANSITION_DEFAULTS[v as TransitionKind], dir: tr?.dir ?? 1 } : null })))
        if (tr) {
          insp.insertAdjacentHTML('beforeend', `<p class="hint">${TRANSITION_INFO[tr.kind].hint}</p>`)
          slider('Duración total', tr.duration, 0.1, 1.5, 0.05, sec, (pr, n) => { const t = O(pr).transition; if (t) t.duration = n })
          slider('Intensidad', tr.intensity, 0.1, 1.5, 0.05, pct, (pr, n) => { const t = O(pr).transition; if (t) t.intensity = n })
          if (tr.kind === 'slide') field('Dirección', select([['-1', 'Entra desde la derecha'], ['1', 'Entra desde la izquierda']], String(tr.dir ?? 1), v =>
            exec(store, { op: 'set_transition', clip: oid, transition: { ...tr, dir: Number(v) as 1 | -1 } })))
        }
        insp.insertAdjacentHTML('beforeend', `<p class="hint dimmer">${note}</p>`)
      }
      transitionSection('Transición de entrada', idx > 0 ? clip : undefined, idx > 0 ? `Es la misma que la salida del clip ${prevClip.id}.` : 'Es el primer clip: no hay corte antes.')
      transitionSection('Transición de salida', nextClip, nextClip ? `Es la misma que la entrada del clip ${nextClip.id}.` : 'Es el último clip: no hay corte después.')

      section('Clip')
      const see = document.createElement('button'); see.textContent = 'Ver este clip'; see.style.marginBottom = '4px'
      see.onclick = () => { const pl = layout(store.project).find(x => x.clip.id === id); if (pl) { player.seek(Math.max(0, pl.start - 0.5)); void player.play() } }
      insp.append(see)
      field('Velocidad (×)', input('number', clip.speed, (pr, v) => { const n = parseFloat(v); if (n > 0) C(pr).speed = Math.min(Math.max(n, 0.1), 8) }, { step: '0.1', min: '0.1', max: '8' }))
      field('Volumen', input('range', clip.volume, (pr, v) => { C(pr).volume = parseFloat(v) }, { min: '0', max: '2', step: '0.05' }))
      const b = document.createElement('button'); b.textContent = 'Borrar clip (ripple)'; b.style.marginTop = '14px'; b.onclick = deleteSelected
      insp.append(b)
    } else if (ov) {
      const id = ov.id, O = (pr: Project) => pr.overlays!.find(o => o.id === id)!
      const asset = store.asset(ov.assetId)
      insp.insertAdjacentHTML('beforeend', `<h3>${ov.kind === 'video' ? 'Video superpuesto' : 'Audio'} · pista ${ov.track + (ov.kind === 'video' ? 1 : 0)}</h3><p class="hint" style="margin:0">${(asset?.name ?? '').replace(/[<&]/g, '')}</p>`)
      field('Volumen', input('range', ov.volume, (pr, v) => { O(pr).volume = parseFloat(v) }, { min: '0', max: '2', step: '0.05' }))
      field('Inicio (s)', input('number', ov.start.toFixed(2), (pr, v) => { O(pr).start = Math.max(0, parseFloat(v) || 0) }, { step: '0.1', min: '0' }))
      if (ov.kind === 'video') {
        field('Tamaño', input('range', ov.transform.scale, (pr, v) => { O(pr).transform.scale = parseFloat(v) }, { min: '0.1', max: '2', step: '0.01' }))
        field('Giro', input('range', ov.transform.rotation || 0, (pr, v) => { O(pr).transform.rotation = parseFloat(v) }, { min: '-180', max: '180', step: '1' }))
        field('Posición horizontal', input('range', ov.transform.x, (pr, v) => { O(pr).transform.x = parseFloat(v) }, { min: '0', max: '1', step: '0.01' }))
        field('Posición vertical', input('range', ov.transform.y, (pr, v) => { O(pr).transform.y = parseFloat(v) }, { min: '0', max: '1', step: '0.01' }))
        field('Opacidad', input('range', ov.transform.opacity, (pr, v) => { O(pr).transform.opacity = parseFloat(v) }, { min: '0', max: '1', step: '0.05' }))
      }
      const b = document.createElement('button'); b.textContent = 'Quitar de la línea de tiempo'; b.style.marginTop = '14px'; b.onclick = deleteSelected
      insp.append(b)
    } else if (lay && (lay.type === 'subtitle' || lay.type === 'graphic')) {
      const id = lay.id
      const T = (pr: Project) => pr.layers.find(o => o.id === id) as TextLayer
      if (lay.type === 'subtitle') {
        insp.insertAdjacentHTML('beforeend', `<div class="pool-tabs"><button class="ptab ${subTab === 'ajustes' ? 'on' : ''}" data-t="ajustes">Ajustes</button><button class="ptab ${subTab === 'lista' ? 'on' : ''}" data-t="lista">Subtítulos</button></div>`)
        insp.querySelectorAll<HTMLButtonElement>('.ptab').forEach(b => { b.onclick = () => { subTab = b.dataset.t as 'ajustes' | 'lista'; lastKey = ''; renderInspector() } })
        if (subTab === 'lista') { buildSubtitleList(lay.id); return }
      }
      insp.insertAdjacentHTML('beforeend', `<h3>${lay.type === 'subtitle' ? 'Subtítulo' : 'Gráfico'} ${id}</h3>`)
      if (lay.type === 'subtitle') {
        const lab = document.createElement('label'); lab.className = 'chk'; lab.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:6px 0'
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = aplicarTodos(); cb.style.cssText = 'width:auto;margin:0'
        cb.onchange = () => { try { localStorage.setItem('gj.aplicarTodos', cb.checked ? '1' : '0') } catch { /* sin almacenamiento */ } }
        lab.append(cb, 'Aplicar a todos los subtítulos'); insp.append(lab)
        insp.insertAdjacentHTML('beforeend', '<p class="hint" style="margin:0 0 8px">Mover, agrandar, estirar o girar un subtítulo lo hace en todos. Desmárcalo para cambiar solo este.</p>')
      }
      if (lay.type === 'graphic') {      // texto DETRÁS de la persona (necesita su recorte: scripts/recortar-persona.py)
        const lab = document.createElement('label'); lab.className = 'chk'; lab.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:6px 0'
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = lay.props?.detras === '1'; cb.style.cssText = 'width:auto;margin:0'
        cb.onchange = () => exec(store, { op: 'update_layer', id, patch: { props: { ...(lay.props ?? {}), detras: cb.checked ? '1' : '0' } } } as Cmd)
        lab.append(cb, 'Poner detrás de la persona'); insp.append(lab)
        const hay = [...player.mattes.keys()].length > 0
        insp.insertAdjacentHTML('beforeend', `<p class="hint" style="margin:0 0 8px">${hay ? 'La persona tapa el texto, como si estuviera entre ella y el fondo.' : 'Falta el recorte de la persona de este video (se crea con scripts/recortar-persona.py): por ahora el texto se ve al frente.'}</p>`)
      }
      field('Texto', input('text', lay.text, (pr, v) => { const l = T(pr); l.text = v; sincronizarPalabras(l) }))
      field('Tamaño', input('number', lay.size, (pr, v) => { T(pr).size = Math.max(10, parseFloat(v) || 10) }, { min: '10', max: '200' }))
      field('Color', input('color', lay.color, (pr, v) => { T(pr).color = v }))
      field('Inicio (s)', input('number', lay.start.toFixed(2), (pr, v) => { T(pr).start = Math.max(0, parseFloat(v) || 0) }, { step: '0.1' }))
      field('Fin (s)', input('number', lay.end.toFixed(2), (pr, v) => { const l = T(pr); l.end = Math.max(l.start + 0.1, parseFloat(v) || 0) }, { step: '0.1' }))
      const b = document.createElement('button'); b.textContent = 'Borrar'; b.style.marginTop = '14px'; b.onclick = deleteSelected
      insp.append(b)
    } else if (s?.type === 'music' && store.project.music) {
      const m = store.project.music, nm = (store.asset(m.assetId)?.name ?? 'música').replace(/[<&]/g, '')
      insp.insertAdjacentHTML('beforeend', `<h3>Música</h3><p class="hint" style="margin:0">${nm}</p>`)
      field('Volumen', input('range', m.volume, (pr, v) => { if (pr.music) pr.music.volume = parseFloat(v) }, { min: '0', max: '2', step: '0.05' }))
      field('Empieza en (s de la canción)', input('number', m.srcIn.toFixed(2), (pr, v) => { if (pr.music) pr.music.srcIn = Math.max(0, parseFloat(v) || 0) }, { step: '0.05', min: '0' }))
      field('Fundido final (s)', input('number', m.fadeOut, (pr, v) => { if (pr.music) pr.music.fadeOut = Math.max(0, parseFloat(v) || 0) }, { step: '0.1', min: '0' }))
      const rm = document.createElement('button'); rm.textContent = 'Quitar música'; rm.style.marginTop = '12px'; rm.onclick = deleteSelected
      insp.append(rm)
    } else {
      buildPool()
    }
  }

  // --- biblioteca de medios (como CapCut): lo que se ve cuando no hay nada seleccionado -------------------
  let poolSig = '', poolQuery = '', poolFilter: 'todo' | 'video' | 'audio' | 'imagen' = 'todo'
  const used = () => new Set<string>([...store.project.clips.map(c => c.assetId), ...(store.project.overlays ?? []).map(o => o.assetId), ...(store.project.music ? [store.project.music.assetId] : [])])
  function drawCard(cv: HTMLCanvasElement, a: AssetInfo, tries = 0) {
    const g = cv.getContext('2d')!, W2 = cv.width, H2 = cv.height
    const la = player.assets.get(a.id)
    if (a.kind === 'audio') {
      g.fillStyle = '#143a66'; g.fillRect(0, 0, W2, H2)
      const pk = player.musicPeaks.get(a.id)
      if (!pk) { if (tries < 20) setTimeout(() => drawCard(cv, a, tries + 1), 500); return }
      g.fillStyle = '#2f86e0'
      for (let x = 0; x < W2; x += 3) { const i0 = Math.floor((x / W2) * pk.length), i1 = Math.max(i0 + 1, Math.floor(((x + 3) / W2) * pk.length)); let mx = 0; for (let i = i0; i < i1; i++) if (pk[i] > mx) mx = pk[i]; const h = Math.max(2, mx * (H2 - 14)); g.fillRect(x, (H2 - h) / 2 + 3, 2, h) }
      return
    }
    if (a.kind === 'image') {        // foto: recortada al centro para llenar la tarjeta, sin estirar
      g.fillStyle = '#26261f'; g.fillRect(0, 0, W2, H2)
      const im = player.images.get(a.id)
      if (!im) { if (tries < 20) setTimeout(() => drawCard(cv, a, tries + 1), 500); return }
      const k = Math.max(W2 / im.width, H2 / im.height), sw = W2 / k, sh = H2 / k
      g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, 0, 0, W2, H2)
      return
    }
    g.fillStyle = '#26261f'; g.fillRect(0, 0, W2, H2)
    const th = la?.thumbs ?? [], N = 8, tw = W2 / N
    for (let i = 0; i < N; i++) {
      const bm = th[Math.min(th.length - 1, Math.floor(((i + 0.5) / N) * a.duration))]
      if (!bm) continue
      const sw = Math.min(bm.width, bm.height * (tw / H2)), sx = (bm.width - sw) / 2     // recorte al centro, sin estirar
      g.drawImage(bm, sx, 0, sw, bm.height, i * tw, 0, tw + 0.5, H2)
    }
    if (th.length < Math.ceil(a.duration) && tries < 24) setTimeout(() => drawCard(cv, a, tries + 1), 600)
  }
  const mmss = (t: number) => { const n = Math.round(t); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` }
  function addAt(a: AssetInfo) { exec(store, { op: 'add_overlay', asset: a.id, start: player.playhead }); const o = store.project.overlays?.at(-1); if (o) store.select({ type: 'overlay', id: o.id }) }
  function poolList() {
    const list = insp.querySelector<HTMLElement>('.pool-list'); if (!list) return
    list.innerHTML = ''
    const q = poolQuery.trim().toLowerCase(), u = used()
    const items = store.project.assets.filter(a => (!q || a.name.toLowerCase().includes(q)) && (poolFilter === 'todo' || (poolFilter === 'audio' ? a.kind === 'audio' : poolFilter === 'imagen' ? a.kind === 'image' : a.kind !== 'audio' && a.kind !== 'image')))
    if (!items.length) list.innerHTML = `<p class="hint">${store.project.assets.length ? 'Sin resultados.' : 'Aún no hay archivos. Pulsa Importar.'}</p>`
    let grid: HTMLElement | null = null
    for (const a of [...items.filter(x => x.kind !== 'image'), ...items.filter(x => x.kind === 'image')]) {
      const foto = a.kind === 'image'
      if (foto && !grid) { grid = document.createElement('div'); grid.className = 'pool-grid'; list.append(grid) }      // las fotos van en cuadrícula de vistas cuadradas
      const box = document.createElement('div'); box.className = foto ? 'pool-item sq' : 'pool-item'
      const card = document.createElement('div'); card.className = foto ? 'pcard sq' : 'pcard'; card.draggable = true
      const cv = document.createElement('canvas'); cv.width = foto ? 256 : 640; cv.height = foto ? 256 : 112; card.append(cv)
      card.insertAdjacentHTML('beforeend', `${u.has(a.id) ? '<span class="pbadge">Agregado</span>' : ''}<span class="pdur">${a.kind === 'image' ? 'Foto' : mmss(a.duration)}</span><button class="padd" title="Agregar en el cabezal">+</button>`)
      card.querySelector<HTMLElement>('.padd')!.onclick = e => { e.stopPropagation(); addAt(a) }
      card.ondragstart = ev => { ev.dataTransfer!.setData('text/gojaguar-asset', a.id); ev.dataTransfer!.effectAllowed = 'copy'; tl.showDropLane(a.kind === 'audio' ? 'audio' : 'video') }
      card.ondragend = () => tl.showDropLane(null)
      box.append(card); box.insertAdjacentHTML('beforeend', `<div class="pname" title="${a.name.replace(/["<&]/g, '')}">${a.name.replace(/[<&]/g, '')}</div>`)
      ;(foto ? grid! : list).append(box); drawCard(cv, a)
    }
  }
  const poolSignature = () => JSON.stringify([store.project.assets.map(a => a.id), [...used()].sort(), poolQuery, poolFilter])
  function updatePool() { const sig = poolSignature(); if (sig !== poolSig && insp.querySelector('.pool')) { poolSig = sig; poolList() } }
  // --- pestañas del panel: Medios | Referencias ---
  let panelTab: 'medios' | 'referencias' = 'medios', refSeq = 0
  const tabsHtml = () => `<div class="pool-tabs"><button class="ptab ${panelTab === 'medios' ? 'on' : ''}" data-t="medios">Medios</button><button class="ptab ${panelTab === 'referencias' ? 'on' : ''}" data-t="referencias">Referencias</button></div>`
  const wireTabs = () => insp.querySelectorAll<HTMLButtonElement>('.ptab').forEach(b => { b.onclick = () => { panelTab = b.dataset.t as typeof panelTab; buildPool() } })

  /** Referencias: se importan, se seleccionan (quedan registradas para Claude) y se ordenan por lo nuevas y lo usadas que son. */
  type Ref = { id: string; nombre: string; usos: number; nueva: boolean; preview: { poster: string | null; video: string | null; listo: boolean } }
  async function buildRefs() {
    const mine = ++refSeq
    insp.innerHTML = `<div class="pool">${tabsHtml()}<div class="pool-top"><button id="r-import" class="pimp" title="Elige videos de tu computador: se enlazan, no se copian"><b>+</b> Importar referencia</button></div>
      <p class="hint dimmer" style="margin:0 0 8px">Toca una para seleccionarla en este proyecto: Claude la verá. Primero van las nuevas y las que más usas.</p>
      <div class="ref-list"></div><p class="pool-note dim" id="r-note"></p></div>`
    wireTabs()
    const note = insp.querySelector<HTMLElement>('#r-note')!
    const abrirVideo = (r: Ref) => {
      if (!r.preview.video) return
      const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="modal-box"><h2>${r.nombre.replace(/[<&]/g, '')}</h2><video src="/${r.preview.video}" controls autoplay playsinline style="width:100%;max-height:60vh;border-radius:12px;background:#000"></video></div>`
      m.onclick = e => { if (e.target === m) m.remove() }; document.body.append(m)
    }
    async function cargar() {
      const [lista, info] = await Promise.all([fetch('/api/referencias').then(r => r.json()) as Promise<Ref[]>, fetch(`/api/proyectos/${slug}`).then(r => r.json())])
      const list = insp.querySelector<HTMLElement>('.ref-list')
      if (mine !== refSeq || !list) return                  // ya se cambió de panel
      const sel = new Set<string>(info.referencias ?? [])
      const frag = document.createDocumentFragment()      // se arma aparte y se cambia de una vez (sin parpadeo)
      if (!lista.length) frag.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Aún no hay referencias. Pulsa Importar referencia.' }))
      for (const r of lista) {
        const card = document.createElement('div'); card.className = 'rcard' + (sel.has(r.id) ? ' on' : '')
        card.innerHTML = `<div class="rthumb">${r.preview.poster ? `<img src="/${r.preview.poster}" alt="">` : '<span class="ph-t">Preparando…</span>'}
          <span class="rchk">${sel.has(r.id) ? ico('check') : ''}</span>${r.nueva ? '<span class="rbadge">Nueva</span>' : ''}${r.usos ? `<span class="rbadge u">Usada ${r.usos}×</span>` : ''}
          ${r.preview.video ? '<button class="rplay" title="Ver la referencia">▶</button>' : ''}</div><div class="pname" title="${r.nombre.replace(/["<&]/g, '')}">${r.nombre.replace(/[<&]/g, '')}</div>`
        card.querySelector<HTMLElement>('.rplay')?.addEventListener('click', e => { e.stopPropagation(); abrirVideo(r) })
        card.onclick = async () => {
          if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id)
          card.classList.toggle('on', sel.has(r.id)); card.querySelector('.rchk')!.innerHTML = sel.has(r.id) ? ico('check') : ''
          await fetch(`/api/proyectos/${slug}/referencias`, { method: 'PUT', body: JSON.stringify({ ids: [...sel] }), headers: { 'content-type': 'application/json' } })
          note.textContent = sel.has(r.id) ? `✓ "${r.nombre}" seleccionada. Claude ya sabe que la elegiste.` : `"${r.nombre}" ya no está seleccionada.`
        }
        frag.append(card)
      }
      list.replaceChildren(frag)
      if (lista.some(r => !r.preview.listo)) setTimeout(() => { if (mine === refSeq) void cargar() }, 2500)     // las miniaturas se generan en segundo plano
    }
    insp.querySelector<HTMLButtonElement>('#r-import')!.onclick = async ev => {
      const btn = ev.currentTarget as HTMLButtonElement; btn.disabled = true; btn.innerHTML = 'Elige los archivos…'
      try {
        const r = await fetch(`/api/referencias/elegir?proyecto=${slug}`, { method: 'POST' }).then(r => r.json())
        if (r.error) throw new Error(r.error)
        note.textContent = r.agregados?.length ? `✓ Subida y seleccionada: ${r.agregados.join(', ')}. Claude ya sabe que la subiste.` : ''
      } catch (e) { note.textContent = (e as Error).message }
      btn.disabled = false; btn.innerHTML = '<b>+</b> Importar referencia'
      await cargar()
    }
    await cargar()
  }

  function buildPool() {
    refSeq++
    if (panelTab === 'referencias') { void buildRefs(); return }
    insp.innerHTML = `<div class="pool">${tabsHtml()}<div class="pool-top"><button id="p-import" class="pimp" title="Elige archivos de tu computador: se enlazan, no se copian"><b>+</b> Importar</button><input id="p-q" type="text" placeholder="Buscar" /></div><div class="pool-filter"><button data-f="todo">Todo</button><button data-f="video">Videos</button><button data-f="imagen">Imágenes</button><button data-f="audio">Audio</button></div><div class="pool-list"></div><p class="pool-note dim" id="p-note"></p></div>`
    wireTabs()
    const q = insp.querySelector<HTMLInputElement>('#p-q')!; q.value = poolQuery
    q.oninput = () => { poolQuery = q.value; poolSig = ''; updatePool() }
    const filters = [...insp.querySelectorAll<HTMLButtonElement>('.pool-filter button')]
    const markFilter = () => filters.forEach(b => b.classList.toggle('on', b.dataset.f === poolFilter))
    filters.forEach(b => { b.onclick = () => { poolFilter = b.dataset.f as typeof poolFilter; markFilter(); poolSig = ''; updatePool() } })
    markFilter()
    insp.querySelector<HTMLElement>('#p-import')!.onclick = async ev => {
      const btn = ev.currentTarget as HTMLButtonElement, note = insp.querySelector<HTMLElement>('#p-note')!
      btn.disabled = true; btn.innerHTML = 'Elige los archivos…'
      try {
        const el = await fetch(`/api/proyectos/${slug}/material/elegir`, { method: 'POST' }).then(r => r.json())
        const ignorados: string[] = el.ignorados ?? []
        btn.innerHTML = 'Preparando…'
        const r = await fetch(`/api/proyectos/${slug}/preparar`, { method: 'POST' }).then(r => r.json())
        if (r.error) throw new Error(r.error)
        if (r.assets.length) { execBatch(store, r.assets.map((a: AssetInfo) => ({ op: 'import_asset', asset: a }) as Cmd)); await loadMedia() }
        const malos = [...ignorados, ...r.omitidos]
        note.textContent = malos.length ? `No se pudieron usar: ${malos.join(', ')} (formato no compatible).` : ''
      } catch (e) { note.textContent = (e as Error).message }
      btn.disabled = false; btn.innerHTML = '<b>+</b> Importar'
      poolSig = ''; updatePool()
    }
    poolSig = ''; updatePool()
  }
  store.onChange(() => { renderInspector(); updAspect(); tl.dirty = true; player.dirty = true; void loadMedia().then(sincronizarVoz) })
  renderInspector()

  // --- bucle principal ---------------------------------------------------------
  player.onSeek = t => tl.reveal(t)
  const timeEl = $('time'), statsEl = $('stats')
  let n = 0, shownPlaying = false
  function frame() {
    player.tick()
    if (tl.dirty || player.playing) tl.draw()
    timeEl.textContent = `${tc(player.time())} / ${tc(duration(store.project))}`
    const zv = (100 * Math.log(tl.pps / 2)) / Math.log(300)
    if (document.activeElement !== zoomR && Math.abs(Number(zoomR.value) - zv) > 0.4) zoomR.value = String(zv)
    if (player.playing !== shownPlaying) { shownPlaying = player.playing; $('play').innerHTML = ico(shownPlaying ? 'pause' : 'play') }
    ;($('undo') as HTMLButtonElement).disabled = !store.canUndo
    ;($('redo') as HTMLButtonElement).disabled = !store.canRedo
    if (++n % 20 === 0) {
      const dec = [...player.assets.values()].reduce((s, a) => s + a.source.stats.decoded, 0)
      statsEl.textContent = `${player.audioStatus ? player.audioStatus + ' · ' : ''}${player.fps.shown} fps · ${dec} frames decodificados · ${layout(store.project).length} clips`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // --- aprendizaje del estilo: se anota (sin gastar tokens) lo que el USUARIO hace a mano; las órdenes de Claude (window.editor.*) no cuentan ---
  let porClaude = false
  const cola: unknown[] = []
  const resumen = (c: Cmd): Record<string, unknown> | null => {
    const x = c as unknown as Record<string, any>
    switch (c.op) {
      case 'set_zoom': return { zoom: x.zoom ? { k: x.zoom.kind, a: x.zoom.amount } : null }
      case 'set_transition': return { tr: x.transition ? { k: x.transition.kind, d: x.transition.duration } : null }
      case 'set_clip_color': return { color: x.color ?? null }
      case 'volume': case 'speed': case 'speed_all': return { v: x.value }
      case 'add_text': case 'add_layer': return { tipo: x.type ?? x.layer?.type, tpl: x.template ?? x.layer?.template, size: x.size ?? x.layer?.size, color: x.color ?? x.layer?.color }
      case 'update_layer': return { campos: Object.keys(x.patch ?? {}).join(',') }
      case 'add_overlay': case 'clip_to_overlay': return { tr: x.transicion ?? null }
      case 'update_overlay': return { campos: Object.keys(x.patch ?? {}).join(',') }
      case 'delete_clip': case 'delete_layer': case 'delete_overlay': case 'split': case 'move_clip': case 'trim': case 'delete_range': case 'delete_ranges': case 'set_music': case 'clear_music': case 'set_format': case 'set_audio_fx': case 'set_clip_transform': return {}
    }
    return null
  }
  let envio = 0
  setAlComando(c => {
    if (porClaude) return
    const r = resumen(c); if (!r) return
    cola.push({ t: Date.now(), op: c.op, ...r })
    clearTimeout(envio); envio = window.setTimeout(() => { const lote = cola.splice(0); void fetch(`/api/proyectos/${slug}/aprendizaje/eventos`, { method: 'POST', body: JSON.stringify(lote), keepalive: true }).catch(() => {}) }, 3000)
  })

  for (const a of avisos) notify(a)

  // API para que Claude (o los tests) controlen el editor con los mismos comandos que la UI
  ;(window as any).editor = {
    store, player, tl,
    exec: (c: Cmd) => { porClaude = true; try { const r = exec(store, c); void loadMedia(); return r } finally { porClaude = false } },
    batch: (cs: Cmd[]) => { porClaude = true; try { const r = execBatch(store, cs); void loadMedia(); return r } finally { porClaude = false } },   // carga también la música recién importada   // varios comandos = una sola entrada de deshacer
    /** `describe('corto')` = resumen sin el detalle de superpuestos y capas (mucho menos texto para leer). */
    describe: (modo?: string) => describe(store, modo === 'corto'),
    /** Verificación NUMÉRICA (regla de movimiento, avisos): texto corto, sin capturas. */
    verificar: () => verificar(store.project).texto,
    /** UNA sola imagen con N momentos de la vista previa (por defecto 12, incluyendo la entrada de cada toma/gráfico): se guarda en analisis/hoja-edicion.jpg para que Claude la mire de una vez. */
    hoja: async (n = 12, momentos?: number[]) => {
      const dur = duration(store.project), p = store.project
      const clave = [...(p.overlays ?? []).filter(o => o.kind === 'video').map(o => o.start + 0.7), ...p.layers.filter(l => l.type === 'graphic').map(l => l.start + 0.8)]
      const ts = (momentos ?? [...new Set([...clave, ...Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n)].map(x => +Math.min(x, dur - 0.05).toFixed(2)))].sort((a, b) => a - b).slice(0, 16))
      const cols = ts.length > 8 ? 4 : Math.min(3, ts.length), tw = 260, th = Math.round(tw * (H / W)), filas = Math.ceil(ts.length / cols)
      const out = document.createElement('canvas'); out.width = cols * tw; out.height = filas * th
      const g = out.getContext('2d')!; g.fillStyle = '#141414'; g.fillRect(0, 0, out.width, out.height); g.font = '700 16px sans-serif'
      const was = player.time()
      for (const [i, t] of ts.entries()) {
        player.seek(t)
        for (let k = 0; k < 40; k++) { await new Promise(r => setTimeout(r, 60)); player.tick(); if (!player.dirty && k >= 3) break }     // dibuja el cuadro aunque la pestaña esté en segundo plano (sin depender de requestAnimationFrame)
        const x = (i % cols) * tw, y = Math.floor(i / cols) * th
        g.drawImage(player.canvas, x, y, tw, th); g.fillStyle = '#000b'; g.fillRect(x, y, 70, 22); g.fillStyle = '#fff'; g.fillText(`${i + 1} ${tc(t)}`, x + 5, y + 16)
      }
      player.seek(was)
      const r = await fetch(`/api/proyectos/${slug}/hoja-edicion`, { method: 'POST', body: out.toDataURL('image/jpeg', 0.75) })
      return `${ts.length} momentos → ${(await r.json()).ruta}`
    },
    serialize: () => serialize(store.project),
    snapshot: () => player.snapshotDataUrl(),
    bench: () => runBench(player, store),
  }
}

