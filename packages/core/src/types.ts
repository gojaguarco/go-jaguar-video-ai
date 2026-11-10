/** Versión actual del formato de archivo .gojaguar. Súbela al cambiar el esquema y añade una migración. */
export const PROJECT_VERSION = 2

export interface Format { width: number; height: number; fps: number }

export interface AssetInfo {
  id: string
  name: string
  kind?: 'video' | 'image' | 'audio'
  proxy: string       // copia liviana para editar (URL api/files/… dentro de la biblioteca del proyecto)
  original: string    // archivo original
  duration: number    // segundos
  fps: number
  width: number       // con `alfa: 'pack'` es el tamaño REAL del objeto (la mitad del ancho del archivo)
  height: number
  /**
   * Video con TRANSPARENCIA (p. ej. una escena de Remotion/three.js): el MP4 trae dos mitades lado a lado, a la izquierda el color PREMULTIPLICADO sobre negro y a la derecha
   * el alfa INVERTIDO en gris. Así lo decodifica cualquier navegador/ffmpeg sin códecs con alfa. Vista previa: `multiply` (apaga el fondo) + `lighter` (suma el color); exportación: alphamerge.
   */
  alfa?: 'pack'
}

/** Zoom: un EFECTO del clip. `push` se acerca, `pull` se aleja (durante todo el clip), `punch` entra con un golpe de zoom y se asienta. */
export type ZoomKind = 'push' | 'pull' | 'punch' | 'temblor' | 'glitch'
export const ZOOM_KINDS: ZoomKind[] = ['push', 'pull', 'punch', 'temblor', 'glitch']
export interface ZoomFx { kind: ZoomKind; amount: number; duration?: number }   // amount: cuánto zoom (0,14 = 14 %; en 'temblor' es la intensidad del temblor); duration: punch y glitch (cuánto dura el golpe); en 'glitch' amount = intensidad del corte de color

/**
 * Transición: vive en el CORTE entre dos clips. Se guarda en el clip que entra, pero es una sola:
 * la mitad de su duración ocurre al final del clip anterior (salida) y la otra mitad al inicio del siguiente (entrada).
 */
export type TransitionKind = 'slide' | 'flash' | 'dip'
export const TRANSITION_KINDS: TransitionKind[] = ['slide', 'flash', 'dip']
export interface Transition { kind: TransitionKind; duration: number; intensity: number; dir?: 1 | -1 }

/** Posición, tamaño y giro del VIDEO de un clip dentro del cuadro. x,y = centro normalizado (0..1); scale = tamaño relativo al ajuste normal (1 = cabe entero, sin deformar). Nunca estira por eje: la relación de aspecto del video no cambia. */
export interface ClipTransform { x: number; y: number; scale: number; rotation: number }
export const CLIP_TRANSFORM_DEFAULT: ClipTransform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 }

/** Luces y color de un clip (1 = sin cambio). Misma fórmula en la vista previa (filtro del lienzo) y en la exportación (ffmpeg): brillo → contraste → saturación. */
export interface ClipColor { brillo: number; contraste: number; saturacion: number }
export const CLIP_COLOR_DEFAULT: ClipColor = { brillo: 1, contraste: 1, saturacion: 1 }

/**
 * Voz limpia y pareja (procedimiento estándar de TODA edición): quita el ruido y nivela la voz para que suene igual de fuerte de principio a fin,
 * también dentro de cada clip y aunque la persona se acerque al micrófono. Lo hace `packages/app/server/voz.ts` sobre el archivo original completo
 * (`proxies/<video>.voz2.m4a`); la vista previa y la exportación usan ese MISMO archivo. Se aplica al audio de los videos (no a música ni efectos).
 * Nivel final: voz a ~-16 dB RMS, picos ≤ -2,5 dBFS (~-17 LUFS): NUNCA más fuerte (la primera versión llegaba a -8,5 LUFS y saturaba).
 */

/** Tramo de un archivo fuente en la pista principal (magnética: sin huecos). */
export interface Clip {
  id: string
  assetId: string
  srcIn: number; srcOut: number   // segundos del archivo fuente
  speed: number; volume: number
  zoom?: ZoomFx
  color?: ClipColor              // luces y color; ausente = sin corrección
  transform?: ClipTransform      // mover / agrandar / girar el video (sin deformarlo); ausente = ajustado y centrado
  transition?: Transition        // la del corte ANTES de este clip (entrada de este y salida del anterior)
}

/** Pista de música: un archivo de audio que suena desde el inicio de la línea de tiempo. */
export interface Music { assetId: string; srcIn: number; volume: number; fadeOut: number }

/** Posición y apariencia de una capa. x,y = centro normalizado (0..1). */
export interface Transform {
  x: number; y: number
  scale: number
  rotation: number     // grados (eje Z)
  opacity: number      // 0..1
  /** Estirado extra por eje (solo capas de texto/gráficos), multiplica a `scale`; 1 = sin estirar. */
  sx?: number; sy?: number
}

/** Valor animado: `t` en segundos desde el inicio de la capa. */
export interface Keyframe { t: number; props: Partial<Transform> }

interface LayerBase {
  id: string
  start: number; end: number    // segundos de la línea de tiempo
  transform: Transform
  keyframes?: Keyframe[]        // reservado: aún no se renderiza
  /** Pista de textos (subtítulos y gráficos, cada tipo con las suyas): 1 = la principal (ausente = 1). Dos capas del mismo tipo NUNCA se pisan en
   *  la misma pista: si chocan, una pasa a otra pista donde quepa (o a una nueva). Ver `acomodarTextos` en timeline.ts. */
  track?: number
}

/** Subtítulo. `template` 'karaoke' dibuja las palabras de `props.palabras` (JSON [[palabra,inicio,fin],…] en segundos de la línea de tiempo) resaltando la que se está diciendo. */
export interface SubtitleLayer extends LayerBase { type: 'subtitle'; text: string; size: number; color: string; template?: string; props?: Record<string, string> }
/** Gráfico. `template`: 'lowerthird' (barra con texto), 'lanzamiento' (rótulo animado de lanzamiento), 'glass' (tarjeta de cristal que entra con perspectiva 3D: props titulo, sub, icono, lado, acento) 'pildora' (píldora de título con texto grande: props texto, acento) o 'escena' (animación 3D sin texto: props tipo 'claude' (chispa) | 'pantalla' (editor o código a cuadro completo), humor 'curioso' | 'loco' | 'triste' | 'feliz' | 'locura', pantalla 'editor' | 'codigo', lado). */
export interface GraphicLayer extends LayerBase { type: 'graphic'; template: string; text: string; size: number; color: string; props?: Record<string, string> }
/** Reservados para etapas posteriores (el modelo ya los soporta; aún no se dibujan). */
export interface ImageLayer extends LayerBase { type: 'image'; assetId: string }
export interface Scene3DLayer extends LayerBase { type: 'scene3d'; template: string; params: Record<string, unknown> }
export interface CutoutLayer extends LayerBase { type: 'cutout'; clipId: string; model: string }

export type Layer = SubtitleLayer | GraphicLayer | ImageLayer | Scene3DLayer | CutoutLayer
export type TextLayer = SubtitleLayer | GraphicLayer
export type LayerType = Layer['type']

export const isTextLayer = (l: Layer): l is TextLayer => l.type === 'subtitle' || l.type === 'graphic'

/**
 * Clip superpuesto, colocado libremente en el tiempo (a diferencia de la pista principal, que es magnética).
 * `track` 1, 2, 3… numera las pistas de su tipo: pistas de video por ENCIMA de la principal y pistas de audio extra.
 * Si dos clips del mismo tipo se solapan en el tiempo, uno va a otra pista (se abre una nueva).
 */
export interface OverlayClip {
  id: string
  assetId: string
  kind: 'video' | 'audio'
  track: number
  start: number                   // segundos en la línea de tiempo
  srcIn: number; srcOut: number   // segundos del archivo fuente
  speed: number; volume: number
  transform: Transform            // posición/tamaño/opacidad (solo video)
  /** Recorte de bordes del propio video/imagen (fracciones 0–0.5 de cada lado): quita barras negras, subtítulos quemados, etc. Nunca deforma. */
  crop?: { l: number; t: number; r: number; b: number }
  /** Entrada/salida: 'fundido' (aparece y se desvanece, 0,35 s), 'subir' (además flota un poco hacia arriba) o '3d' (la card entra y sale girando en 3D). */
  transicion?: 'fundido' | 'subir' | '3d'
  /**
   * Máscara tipo CARD (p. ej. 4:5 con esquinas redondeadas): el video/imagen COMPLETO sigue ahí (se puede mover y agrandar con su `transform`),
   * pero solo se ve lo que cae dentro de esta ventana. x,y = centro (0–1 del cuadro), w = ancho (0–1 del cuadro), aspect = ancho/alto (4:5 = 0.8), r = radio de esquina (0–0.5 del ancho).
   */
  mascara?: { x: number; y: number; w: number; aspect: number; r: number }
  blend?: 'screen'                // 'screen' suma la luz del clip al video de abajo (luces, destellos, humo): lo negro no se ve
  color?: ClipColor               // luces y color (misma fórmula que los clips de la pista principal); ausente = sin corrección
  /** Fundido del AUDIO al entrar y al salir, en segundos (música, efectos, voz de un superpuesto). Ausente = corte seco. */
  fundido?: { entrada?: number; salida?: number }
}

/** Estado de una pista de la línea de tiempo. Claves: 'main', 'music', 'subtitle', 'graphic', 'v1','v2'… (video superpuesto) y 'a1','a2'… (audio extra). */
export interface TrackState { locked?: boolean; hidden?: boolean; muted?: boolean }

export interface Project {
  version: number
  name: string
  format: Format
  assets: AssetInfo[]
  clips: Clip[]
  layers: Layer[]
  music?: Music
  /** Mejoras automáticas: `audio` = voz limpia y pareja (ver packages/app/server/voz.ts). */
  mejoras?: { audio?: boolean }
  overlays?: OverlayClip[]
  tracks?: Record<string, TrackState>
  nextId: number
}

export function createProject(name = 'Proyecto sin título', format: Format = { width: 1280, height: 720, fps: 30 }): Project {
  return { version: PROJECT_VERSION, name, format, assets: [], clips: [], layers: [], nextId: 1 }
}

export const DEFAULT_TRANSFORM: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }

/** Formato de un proyecto según un video (ya con su giro): misma forma, con el lado corto como máximo 1080 para que editar y exportar sea ágil. */
export function formatoDe(w: number, h: number, fps: number): Format {
  const k = Math.min(1, 1080 / Math.min(w, h)), par = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2)
  return { width: par(w), height: par(h), fps: Math.round(fps) || 30 }
}
