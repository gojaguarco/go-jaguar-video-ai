import { describe, expect, it } from 'vitest'
import { Store, createProject, exec, execBatch, overlayEnd, type AssetInfo } from '../src'

const aud: AssetInfo = { id: 'a1', name: 'musica', kind: 'audio', proxy: 'm.m4a', original: 'm.mp3', duration: 60, fps: 0, width: 0, height: 0 }
const base = () => { const s = new Store(createProject('t')); execBatch(s, [{ op: 'import_asset', asset: aud }, { op: 'add_overlay', asset: 'a1', start: 2, src_in: 10, src_out: 20 }]); return s }

describe('cortar y recortar clips superpuestos (S, Q, W)', () => {
  it('split_overlay parte el clip en dos que siguen seguidos y conservan su audio', () => {
    const s = base(), o = s.project.overlays![0]
    exec(s, { op: 'split_overlay', id: o.id, at: 5 })
    const [a, b] = s.project.overlays!
    expect([a.start, a.srcIn, a.srcOut, overlayEnd(a)]).toEqual([2, 10, 13, 5])
    expect([b.start, b.srcIn, b.srcOut, overlayEnd(b)]).toEqual([5, 13, 20, 12])
  })
  it('trim_overlay: Q borra lo anterior al cabezal y W lo posterior, sin mover el resto', () => {
    const s = base(), id = s.project.overlays![0].id
    exec(s, { op: 'trim_overlay', id, lado: 'antes', at: 4 })
    expect([s.project.overlays![0].start, s.project.overlays![0].srcIn]).toEqual([4, 12])
    exec(s, { op: 'trim_overlay', id, lado: 'despues', at: 9 })
    expect(overlayEnd(s.project.overlays![0])).toBe(9)
  })
  it('fuera del clip no hace nada', () => {
    const s = base(), id = s.project.overlays![0].id
    expect(exec(s, { op: 'split_overlay', id, at: 30 })).toMatch(/no está dentro/)
    expect(s.project.overlays!.length).toBe(1)
  })
  it('fundido de audio: se guarda, se limita a la mitad del clip y al cortar cada parte conserva el suyo', () => {
    const s = base(), id = s.project.overlays![0].id
    exec(s, { op: 'update_overlay', id, patch: { fundido: { entrada: 1, salida: 99 } } })
    expect(s.project.overlays![0].fundido).toEqual({ entrada: 1, salida: 5 })
    exec(s, { op: 'split_overlay', id, at: 6 })
    expect(s.project.overlays!.map(o => o.fundido)).toEqual([{ entrada: 1 }, { salida: 5 }])
    exec(s, { op: 'update_overlay', id, patch: { fundido: { entrada: 0 } } })
    expect(s.project.overlays![0].fundido).toBeUndefined()
  })
})
