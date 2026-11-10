import './style.css'
import { bootEditor } from './editor'
import { applyIcons } from './icons'
import { renderHome, renderProject } from './views'
import { renderGuion } from './guion'
import { renderPropuesta } from './propuesta'
import { renderEditando } from './editando'
import { api } from './api'
import { bootRender } from './render'

void document.fonts?.load('400 14px Figtree'); void document.fonts?.load('700 14px Figtree'); void document.fonts?.load('900 14px Montserrat')
const isEditor = (h: string) => h.startsWith('#/editor/')
const renderMatch = /^#\/render\/([a-z0-9-]+)\?w=(\d+)&h=(\d+)/.exec(location.hash)   // página interna de la exportación (Chromium sin pantalla)
const modeAtLoad = isEditor(location.hash)

function route() {
  const h = location.hash || '#/'
  const shell = document.getElementById('shell')!, app = document.getElementById('app')!
  if (isEditor(h)) {
    shell.hidden = true; app.hidden = false
    void bootEditor(h.slice('#/editor/'.length)).catch(e => { console.error(e); document.getElementById('loading')!.textContent = 'Error: ' + (e?.message ?? e) })
  } else {
    app.hidden = true; shell.hidden = false
    const m = /^#\/p\/([a-z0-9-]+)$/.exec(h)
    const gm = /^#\/p\/([a-z0-9-]+)\/guion$/.exec(h)
    const pm = /^#\/p\/([a-z0-9-]+)\/propuesta$/.exec(h)
    const em = /^#\/p\/([a-z0-9-]+)\/editando$/.exec(h)
    const slug = (m ?? gm ?? pm ?? em)?.[1]
    if (!slug) return void renderHome()
    // Guardia de etapa: una vez el video está en el editor no se vuelve a las pantallas de creación; mientras Claude edita, solo la pantalla de carga.
    void api.fase(slug).then(f => {
      if (f.etapa === 'editor') { location.hash = `#/editor/${slug}`; return }
      if (f.etapa === 'editando' && !em) { location.hash = `#/p/${slug}/editando`; return }
      void (em ? renderEditando(slug) : pm ? renderPropuesta(slug) : gm ? renderGuion(slug) : renderProject(slug))
    }).catch(() => void renderHome())
  }
}

// Entrar o salir del editor recarga la página (limpia listeners y el motor de video).
window.addEventListener('hashchange', () => { if (renderMatch) return; if (isEditor(location.hash) || modeAtLoad) location.reload(); else route() })
if (renderMatch) void bootRender(renderMatch[1], Number(renderMatch[2]), Number(renderMatch[3]))
else { applyIcons(); route() }
