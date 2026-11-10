import { describe, expect, it } from 'vitest'
import { Store, acomodarTextos, createProject, exec, execBatch, freeTextTrack, pistaTexto, type Project } from '../src'

const sub = (start: number, end: number, text = 'x') => ({ op: 'add_text' as const, type: 'subtitle' as const, start, end, text })
const pistas = (p: Project) => p.layers.filter(l => l.type === 'subtitle').map(l => `${(l as { text?: string }).text}:${pistaTexto(l)}`)
const sinSolapes = (p: Project) => {
  for (const tipo of ['subtitle', 'graphic']) {
    const ls = p.layers.filter(l => l.type === tipo)
    for (const a of ls) for (const b of ls) if (a !== b && pistaTexto(a) === pistaTexto(b) && a.start < b.end - 1e-6 && a.end > b.start + 1e-6) return false
  }
  return true
}

describe('pistas de texto: nunca un subtítulo detrás de otro', () => {
  it('si un subtítulo se solapa con otro, pasa a una pista secundaria', () => {
    const s = new Store(createProject('t'))
    execBatch(s, [sub(0, 2, 'a'), sub(1, 3, 'b'), sub(4, 5, 'c')])
    expect(pistas(s.project)).toEqual(['a:1', 'b:2', 'c:1'])
    expect(sinSolapes(s.project)).toBe(true)
  })
  it('se imanta a la pista secundaria existente si cabe, en vez de abrir otra', () => {
    const s = new Store(createProject('t'))
    execBatch(s, [sub(0, 2, 'a'), sub(1, 3, 'b'), sub(5, 7, 'c')])        // b abrió la pista 2
    exec(s, sub(5.5, 6.5, 'd'))                                           // choca con c en la 1 → cabe en la 2 (b termina en 3)
    expect(pistas(s.project)).toEqual(['a:1', 'b:2', 'c:1', 'd:2'])
  })
  it('se respeta la pista elegida, y las pistas que quedan vacías desaparecen', () => {
    const s = new Store(createProject('t'))
    execBatch(s, [sub(0, 2, 'a'), sub(1, 3, 'b')])
    const b = s.project.layers.find(l => (l as { text?: string }).text === 'b')!
    exec(s, { op: 'update_layer', id: b.id, patch: { start: 4, end: 6 } })
    expect(pistas(s.project)).toEqual(['a:1', 'b:2'])                    // ya no choca, pero se queda donde el usuario lo puso
    exec(s, { op: 'delete_layer', id: s.project.layers.find(l => (l as { text?: string }).text === 'a')!.id })
    expect(pistas(s.project)).toEqual(['b:1'])                           // la pista 1 quedó vacía → b baja
  })
  it('freeTextTrack: la pista bajo el mouse si cabe, si no la libre más cercana, si no una nueva', () => {
    const s = new Store(createProject('t'))
    execBatch(s, [sub(0, 2, 'a'), sub(1, 3, 'b')])
    expect(freeTextTrack(s.project, 'subtitle', 5, 6, 2)).toBe(2)       // cabe donde se suelta
    expect(freeTextTrack(s.project, 'subtitle', 0.5, 1.5, 1)).toBe(3)   // 1 y 2 ocupadas → nueva
    expect(freeTextTrack(s.project, 'subtitle', 2.5, 3.5, 2)).toBe(1)   // la 2 está ocupada → imán a la 1
  })
  it('subtítulos y gráficos tienen pistas separadas', () => {
    const s = new Store(createProject('t'))
    execBatch(s, [sub(0, 2, 'a'), { op: 'add_text', type: 'graphic', start: 0, end: 2, text: 'g' }])
    expect(s.project.layers.map(l => pistaTexto(l))).toEqual([1, 1])
  })
  it('acomodarTextos arregla un proyecto viejo con textos superpuestos', () => {
    const s = new Store(createProject('t'))
    s.project.layers.push(...[[0, 2], [1, 3], [1.5, 2.5]].map(([a, b], i) => ({ id: 's' + i, type: 'subtitle' as const, start: a, end: b, text: 't' + i, size: 54, color: '#fff', transform: { x: 0.5, y: 0.85, scale: 1, rotation: 0, opacity: 1 } })))
    acomodarTextos(s.project)
    expect(sinSolapes(s.project)).toBe(true)
    expect(pistas(s.project)).toEqual(['t0:1', 't1:2', 't2:3'])
  })
})
