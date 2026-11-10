#!/usr/bin/env node
// Corre un script de Python con el intérprete correcto en Mac, Windows y Linux (no hace falta saber si es `python` o `python3`).
//   node scripts/py.mjs scripts/ilustrar.py Iconos '{...}' 12
//   node scripts/py.mjs --alinear scripts/alinear-palabras.py audio.wav words.json salida.json     (entorno de torch, solo karaoke)
// Usa el entorno que crea `npm run instalar` (~/.gojaguar-py); si no existe, el Python del sistema. GOJAGUAR_PYTHON lo fuerza.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const win = process.platform === 'win32'
// Las herramientas que instala `npm run instalar` (whisper-cli en ~/.gojaguar-bin; en Windows ffmpeg en WinGet\Links) no siempre están en el PATH
// de la terminal que llama (winget no lo actualiza hasta reabrirla): se añaden aquí, igual que hace el servidor, para que los scripts las encuentren.
const extra = [join(homedir(), '.gojaguar-bin'), ...(win ? [join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links')] : ['/opt/homebrew/bin', '/usr/local/bin'])]
process.env.PATH = [...extra, process.env.PATH ?? ''].join(delimiter)
const enEntorno = d => join(homedir(), d, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
const args = process.argv.slice(2)
let entorno = '.gojaguar-py'
if (args[0] === '--alinear') { entorno = '.gojaguar-alinear'; args.shift() }
if (!args.length) { console.error('Uso: node scripts/py.mjs [--alinear] <script.py> [argumentos]'); process.exit(2) }

const py = process.env.GOJAGUAR_PYTHON || (existsSync(enEntorno(entorno)) ? enEntorno(entorno) : win ? 'python' : 'python3')
const r = spawnSync(py, args, { stdio: 'inherit' })
if (r.error) { console.error(`No pude ejecutar ${py}: ${r.error.message}\nCorre primero:  npm run instalar`); process.exit(1) }
process.exit(r.status ?? 1)
