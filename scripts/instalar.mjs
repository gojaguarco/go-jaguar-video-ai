#!/usr/bin/env node
// Prepara TODO lo que necesita el editor en Mac, Windows y Linux. Idempotente: lo que ya está, se salta.
//   npm run instalar                  → solo REVISA y dice qué falta (no instala nada)
//   npm run instalar -- --instalar    → instala lo que falte (winget/brew, Python, modelos, npm)   ← pedir permiso al usuario antes
//   opciones: --sin-modelos (no baja whisper medium ni el modelo de recorte). La alineación por audio (torch, +1,5 GB) es IMPRESCINDIBLE y siempre se instala.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, renameSync, createWriteStream, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve, delimiter } from 'node:path'
import { homedir, tmpdir, platform, arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const INSTALAR = args.has('--instalar'), MODELOS = !args.has('--sin-modelos')
const win = platform() === 'win32', mac = platform() === 'darwin'
const home = homedir()
const BIN = join(home, '.gojaguar-bin')               // whisper-cli.exe en Windows (el servidor lo agrega al PATH)
const PYENV = join(home, '.gojaguar-py'), ALINENV = join(home, '.gojaguar-alinear')
const enEnv = d => join(d, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
const MODELO_WHISPER = process.env.GOJAGUAR_WHISPER_MODEL ?? join(home, '.whisper-models', 'ggml-medium.bin')
const MODELO_RVM = join(home, '.gojaguar-recorte', 'modelos', 'rvm_mobilenetv3_fp32.onnx')
const WHISPER_WIN = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip'
const URL_WHISPER_MODELO = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin'
const URL_RVM = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx'

const resultado = []   // { nombre, ok, nota, obligatorio }
const anota = (nombre, ok, nota = '', obligatorio = true) => { resultado.push({ nombre, ok, nota, obligatorio }); console.log(`${ok ? '✓' : obligatorio ? '✗' : '·'} ${nombre}${nota ? ' — ' + nota : ''}`) }

// El PATH de este proceso incluye lo que acabamos de instalar (winget no actualiza la terminal abierta).
const extra = [BIN, ...(win ? [join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links'), 'C:\\Program Files\\nodejs'] : ['/opt/homebrew/bin', '/usr/local/bin'])]
process.env.PATH = [...extra, process.env.PATH ?? ''].join(delimiter)

// En Windows se usa la shell (npm es un .cmd), y con shell Node junta los argumentos sin comillas:
// `python -c import sys;print(...)` llegaba roto. Por eso se citan los que llevan espacios o símbolos.
const cita = s => (win && /[\s"&|<>^;(),%]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s)
const corre = (cmd, a, o = {}) => win ? spawnSync(cita(cmd), a.map(cita), { encoding: 'utf8', shell: true, ...o }) : spawnSync(cmd, a, { encoding: 'utf8', ...o })
const existeCmd = (cmd, a = ['-version']) => { const r = corre(cmd, a); return !r.error && r.status === 0 }
const winget = id => corre('winget', ['install', '-e', '--id', id, '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit' }).status === 0
const brew = (...a) => corre('brew', a, { stdio: 'inherit' }).status === 0

async function descarga(url, destino, etiqueta) {
  mkdirSync(dirname(destino), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${etiqueta}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0); let hecho = 0, ultimo = 0
  const tmp = destino + '.part'
  const lector = Readable.fromWeb(res.body)
  lector.on('data', c => { hecho += c.length; const p = total ? Math.floor(hecho / total * 100) : 0; if (p >= ultimo + 10) { ultimo = p; process.stdout.write(`  ${etiqueta}: ${p}%\n`) } })
  await pipeline(lector, createWriteStream(tmp)); renameSync(tmp, destino)
}

// ---- 1. Node ----
const nodeMayor = Number(process.versions.node.split('.')[0])
anota('Node 22+', nodeMayor >= 22, `versión ${process.versions.node}`)

// ---- 2. ffmpeg / ffprobe ----
let hayFF = existeCmd('ffmpeg') && existeCmd('ffprobe')
if (!hayFF && INSTALAR) { console.log('Instalando ffmpeg…'); if (win) winget('Gyan.FFmpeg'); else if (mac) brew('install', 'ffmpeg'); hayFF = existeCmd('ffmpeg') && existeCmd('ffprobe') }
anota('ffmpeg + ffprobe', hayFF, hayFF ? '' : win ? 'winget install Gyan.FFmpeg (luego CIERRA y abre la terminal)' : mac ? 'brew install ffmpeg' : 'sudo apt install ffmpeg')

// ---- 3. Python 3.9+ ----
const buscaPython = () => { for (const c of win ? ['python', 'py -3'] : ['python3', 'python']) { const [cmd, ...a] = c.split(' '); const r = corre(cmd, [...a, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])']); if (!r.error && r.status === 0 && Number(r.stdout.trim()) >= 309) return [cmd, ...a] } return null }
let py = buscaPython()
if (!py && INSTALAR) { console.log('Instalando Python…'); if (win) winget('Python.Python.3.12'); else if (mac) brew('install', 'python'); py = buscaPython() ?? (win ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe')] : null); if (py && !existeCmd(py[0], [...py.slice(1), '--version'])) py = null }
anota('Python 3.9+', !!py, py ? py.join(' ') : win ? 'winget install Python.Python.3.12 (luego CIERRA y abre la terminal)' : mac ? 'brew install python' : 'sudo apt install python3 python3-venv')

// ---- 4. Entorno de Python (paquetes de requirements.txt) ----
function entorno(dir, req, etiqueta, obligatorio) {
  const listo = existsSync(enEnv(dir))
  if (!listo && INSTALAR && py) {
    console.log(`Creando ${etiqueta} (puede tardar unos minutos)…`)
    corre(py[0], [...py.slice(1), '-m', 'venv', dir], { stdio: 'inherit' })
    corre(enEnv(dir), ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' })
    corre(enEnv(dir), ['-m', 'pip', 'install', '-r', join(raiz, req)], { stdio: 'inherit' })
  }
  const mods = req === 'requirements.txt' ? 'import numpy, PIL, onnxruntime, scenedetect' : 'import torch, torchaudio, transformers'
  const enVenv = existsSync(enEnv(dir)) && existeCmd(enEnv(dir), ['-c', mods])
  const enSistema = !enVenv && req === 'requirements.txt' && py && existeCmd(py[0], [...py.slice(1), '-c', mods])   // ya instalados a mano en el Python del sistema
  const ok = enVenv || enSistema
  anota(etiqueta, ok, enVenv ? dir : enSistema ? 'en el Python del sistema' : 'npm run instalar -- --instalar', obligatorio)
}
if (py || existsSync(enEnv(PYENV))) entorno(PYENV, 'requirements.txt', 'Paquetes de Python (ilustraciones, escenas, recorte de persona, audio)', true)
// IMPRESCINDIBLE: Whisper da el texto, pero sus tiempos se desfasan hasta ~1 s. Esta alineación (wav2vec2) da el segundo exacto de cada palabra (~30-50 ms)
// y de ahí salen los cortes, las tomas de apoyo y los subtítulos. Sin ella las ediciones y recortes no quedan bien.
if (py || existsSync(enEnv(ALINENV))) entorno(ALINENV, 'requirements-alinear.txt', 'Alineación de palabras por audio (torch) — imprescindible', true)

// ---- 5. whisper-cli + modelo (texto/transcripción) ----
let hayW = existeCmd('whisper-cli', ['-h'])
if (!hayW && INSTALAR) {
  console.log('Instalando whisper-cli…')
  if (mac) brew('install', 'whisper-cpp')
  else if (win && arch() === 'x64') {
    const tmp = mkdtempSync(join(tmpdir(), 'whisper-')); const zip = join(tmp, 'w.zip')
    try {
      await descarga(WHISPER_WIN, zip, 'whisper-cli')
      corre('tar', ['-xf', zip, '-C', tmp])
      mkdirSync(BIN, { recursive: true })
      for (const f of readdirSync(join(tmp, 'Release'))) if (/\.(exe|dll)$/i.test(f)) copyFileSync(join(tmp, 'Release', f), join(BIN, f))
    } catch (e) { console.log('  falló: ' + e.message) } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
  hayW = existeCmd('whisper-cli', ['-h'])
}
anota('whisper-cli (texto: base de la alineación)', hayW, hayW ? '' : win ? 'se baja a ~/.gojaguar-bin con --instalar (solo Windows x64)' : mac ? 'brew install whisper-cpp' : 'compilar whisper.cpp y dejar whisper-cli en el PATH', true)
const modeloOk = () => existsSync(MODELO_WHISPER) && statSync(MODELO_WHISPER).size > 1.4e9
if (MODELOS && !modeloOk() && INSTALAR) { console.log('Bajando modelo de voz (1,5 GB)…'); await descarga(URL_WHISPER_MODELO, MODELO_WHISPER, 'ggml-medium').catch(e => console.log('  falló: ' + e.message)) }
anota('Modelo de voz ggml-medium.bin', modeloOk(), modeloOk() ? '' : '1,5 GB; con --instalar se baja a ' + MODELO_WHISPER, true)

// ---- 6. Modelo de recorte de persona (Robust Video Matting, GPL-3.0, se baja aparte) ----
const rvmOk = () => existsSync(MODELO_RVM) && statSync(MODELO_RVM).size > 1e7
if (MODELOS && !rvmOk() && INSTALAR) { console.log('Bajando modelo de recorte (15 MB)…'); await descarga(URL_RVM, MODELO_RVM, 'rvm').catch(e => console.log('  falló: ' + e.message)) }
anota('Modelo de recorte de persona', rvmOk(), rvmOk() ? '' : '15 MB; con --instalar se baja a ' + MODELO_RVM, false)

// ---- 7. Chrome (dibuja los textos y subtítulos al exportar) ----
const chromes = win ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
  : mac ? ['/Applications/Google Chrome.app', '/Applications/Chromium.app', '/Applications/Microsoft Edge.app'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const hayChrome = () => chromes.some(existsSync) || existsSync(join(home, 'AppData', 'Local', 'ms-playwright')) || existsSync(join(home, 'Library', 'Caches', 'ms-playwright')) || existsSync(join(home, '.cache', 'ms-playwright'))
if (!hayChrome() && INSTALAR) { console.log('Instalando Google Chrome…'); if (win) winget('Google.Chrome'); else if (mac) brew('install', '--cask', 'google-chrome') }
anota('Google Chrome (para exportar con textos)', hayChrome(), hayChrome() ? '' : win ? 'winget install Google.Chrome' : mac ? 'brew install --cask google-chrome' : 'instalar google-chrome o chromium', true)

// ---- 8. Dependencias de npm (editor y animaciones Remotion) ----
for (const [dir, etiqueta] of [[raiz, 'npm del editor'], [join(raiz, 'experiments', 'estilo-3d'), 'npm de las animaciones (Remotion)']]) {
  const ok = () => existsSync(join(dir, 'node_modules'))
  if (!ok() && INSTALAR) { console.log(`npm install (${etiqueta})…`); corre('npm', ['install'], { cwd: dir, stdio: 'inherit' }) }
  anota(etiqueta, ok(), ok() ? '' : 'npm run instalar -- --instalar', true)
}

const faltan = resultado.filter(r => !r.ok && r.obligatorio)
console.log('\n' + (faltan.length ? `Faltan ${faltan.length} cosas obligatorias.${INSTALAR ? ' Si acabas de instalar algo en Windows, CIERRA y abre la terminal y vuelve a correr: npm run instalar' : ' Para instalarlas: npm run instalar -- --instalar'}` : 'Todo listo. Arranca con: npm run dev  →  http://127.0.0.1:5273'))
if (resultado.some(r => !r.ok && !r.obligatorio)) console.log('(Las marcadas con · son opcionales: sin ellas esa función se omite, el resto funciona.)')
process.exit(faltan.length ? 1 : 0)
