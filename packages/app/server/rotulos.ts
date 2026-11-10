/**
 * Renderiza los rótulos (subtítulos y gráficos) como secuencia de PNG con transparencia usando un Chromium sin pantalla.
 * La página /#/render/<proyecto> dibuja con el mismo código del editor. Habla con Chromium por el protocolo DevTools (sin dependencias).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function findChromium(): { bin: string; headlessShell: boolean } | null {
  const home = os.homedir()
  for (const base of [path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright'), path.join(home, 'AppData/Local/ms-playwright')]) {
    if (!fs.existsSync(base)) continue
    for (const d of fs.readdirSync(base).sort().reverse()) {
      if (!d.startsWith('chromium_headless_shell')) continue
      for (const sub of fs.readdirSync(path.join(base, d))) {
        const f = path.join(base, d, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell')
        if (fs.existsSync(f)) return { bin: f, headlessShell: true }
      }
    }
  }
  for (const f of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (fs.existsSync(f)) return { bin: f, headlessShell: false }
  return null
}

export const hayNavegador = () => !!findChromium()

export async function renderRotulos(opts: { origin: string; slug: string; w: number; h: number; fps: number; t0: number; t1: number; outDir: string; capa?: 'todas' | 'detras' | 'frente'; onProgress?: (p: number) => void; cancelled?: () => boolean }) {
  const found = findChromium()
  if (!found) throw new Error('No encuentro Chrome/Chromium para dibujar los rótulos. Instala Google Chrome.')
  await fsp.mkdir(opts.outDir, { recursive: true })
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'gojaguar-chrome-'))
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', ...(found.headlessShell ? [] : ['--headless=new']), 'about:blank']
  const proc: ChildProcess = spawn(found.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let ws: WebSocket | null = null
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''; const to = setTimeout(() => reject(new Error('Chromium no arrancó')), 20000)
      proc.stderr!.on('data', d => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(to); resolve(m[1]) } })
      proc.on('error', reject); proc.on('close', () => reject(new Error('Chromium se cerró')))
    })
    const port = new URL(wsUrl).port
    let pageWs = ''
    for (let i = 0; i < 40 && !pageWs; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []) as { type: string; webSocketDebuggerUrl: string }[]
      pageWs = list.find(x => x.type === 'page')?.webSocketDebuggerUrl ?? ''
      if (!pageWs) await new Promise(r => setTimeout(r, 150))
    }
    if (!pageWs) throw new Error('No pude abrir una página en Chromium')
    ws = new WebSocket(pageWs)
    await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('No pude conectar con Chromium')) })
    let id = 0; const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>()
    ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
    const send = (method: string, params: object = {}) => new Promise<any>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws!.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expression: string) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'Error en la página de rótulos')
      return r.result.value
    }
    await send('Emulation.setDeviceMetricsOverride', { width: opts.w, height: opts.h, deviceScaleFactor: 1, mobile: false })
    await send('Page.enable')
    await send('Page.navigate', { url: `${opts.origin}/#/render/${opts.slug}?w=${opts.w}&h=${opts.h}&capa=${opts.capa ?? 'todas'}` })
    let ready = false
    for (let i = 0; i < 200 && !ready; i++) { ready = await evaluate('window.__ready === true').catch(() => false); if (!ready) await new Promise(r => setTimeout(r, 150)) }
    if (!ready) throw new Error('La página de rótulos no cargó')
    // Rápido: a lo sumo 30 cuadros por segundo (los rótulos no necesitan más), y un cuadro vacío o IGUAL al anterior no se vuelve a guardar:
    // se alarga su duración en una lista (`lista.txt`, formato concat de ffmpeg). Antes se dibujaban y guardaban miles de PNG casi todos repetidos.
    const fpsR = Math.min(opts.fps, 30), paso = 1 / fpsR
    const n = Math.max(1, Math.ceil((opts.t1 - opts.t0) * fpsR) + 1)
    const vacio = await evaluate('window.__vacio()') as string
    await fsp.writeFile(path.join(opts.outDir, 'vacio.png'), Buffer.from(vacio.split(',')[1], 'base64'))
    const lista: { file: string; dur: number }[] = []
    let prev = '', escritos = 0
    for (let i = 0; i < n; i++) {
      if (opts.cancelled?.()) throw new Error('Cancelado')
      const url = await evaluate(`window.__draw(${(opts.t0 + i * paso).toFixed(4)})`) as string
      const clave = url === 'igual' ? prev : (url || 'vacio')
      if (lista.length && clave === prev) lista[lista.length - 1].dur += paso
      else {
        let file = 'vacio.png'
        if (url) { file = `${String(escritos++).padStart(5, '0')}.png`; await fsp.writeFile(path.join(opts.outDir, file), Buffer.from(url.split(',')[1], 'base64')) }
        lista.push({ file, dur: paso }); prev = clave
      }
      opts.onProgress?.((i + 1) / n)
    }
    const txt = lista.map(x => `file '${x.file}'\nduration ${x.dur.toFixed(5)}\n`).join('') + `file '${lista[lista.length - 1].file}'\n`
    await fsp.writeFile(path.join(opts.outDir, 'lista.txt'), txt)
    return { frames: n, guardados: escritos }
  } finally {
    try { ws?.close() } catch { /* ya cerrado */ }
    // Windows no deja borrar archivos que Chromium aún tiene abiertos (EBUSY en CrashpadMetrics-active.pma): se espera a que el proceso
    // salga y se reintenta; si aun así falla, la carpeta temporal se queda (la limpia el sistema) en vez de tumbar el servidor con un rechazo sin atender.
    const salio = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(r => { proc.once('exit', () => r()); setTimeout(r, 5000) })
    proc.kill('SIGKILL')
    void salio.then(() => fsp.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })).catch(() => { /* carpeta temporal: no importa */ })
  }
}
