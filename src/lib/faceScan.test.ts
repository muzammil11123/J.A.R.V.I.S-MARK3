import { describe, expect, it } from 'vitest'
import type { FaceReading } from './face'
import { averageDescriptor, scanFace, ScanAborted, ScanTimeout, type ScanProgress } from './faceScan'

/**
 * The scan, driven by scripted readings instead of a camera. Each reading
 * advances a fake clock by one frame, so timeouts and blink timing are exact
 * and the tests take milliseconds.
 */

const FRAME_MS = 50
const video = {} as HTMLVideoElement
const emb = (v = 0.1) => new Array(1024).fill(v)

const live = (o: Partial<FaceReading> = {}): FaceReading => ({
  faces: 1,
  box: [0.4, 0.3, 0.2, 0.3],
  size: 220,
  confidence: 0.9,
  real: 0.9,
  live: 0.9,
  facing: 'center',
  eyesClosed: false,
  embedding: emb(),
  ...o,
})
const nobody: FaceReading = { faces: 0, box: null, size: 0, confidence: 0, real: 0, live: 0, facing: null, eyesClosed: false, embedding: null }

/** A reader that plays `script` in order, then repeats `then` for ever. */
function scripted(script: FaceReading[], then: FaceReading = live()) {
  let t = 0
  let i = 0
  return {
    now: () => t,
    read: async () => {
      t += FRAME_MS
      return i < script.length ? script[i++] : then
    },
  }
}

const blink = [live(), live(), live({ eyesClosed: true, embedding: null }), live({ eyesClosed: true }), live()]

describe('face detection and scanning', () => {
  it('reports searching with no face, then detected once one appears', async () => {
    const s = scripted([nobody, nobody, ...blink])
    const seen: ScanProgress['stage'][] = []
    await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 5000, now: s.now, wait: async () => {}, onProgress: (p) => seen.push(p.stage) })
    expect(seen[0]).toBe('searching')
    expect(seen).toContain('detected')
    expect(seen.at(-1)).toBe('collecting')
  })

  it('collects descriptors only after a blink and only from open-eyed, frontal frames', async () => {
    const s = scripted(blink)
    const r = await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 5000, now: s.now, wait: async () => {} })
    expect(r.samples).toHaveLength(3)
    expect(r.samples.every((e) => e.length === 1024)).toBe(true)
  })

  it('never verifies a face that does not blink (a photo held still)', async () => {
    const s = scripted([], live())
    await expect(scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 2000, now: s.now, wait: async () => {} })).rejects.toThrow(/blink/i)
  })

  it('rejects a face the anti-spoof model calls a print or screen, even if it blinks', async () => {
    const spoof = (o: Partial<FaceReading> = {}) => live({ real: 0.2, ...o })
    const s = scripted([spoof(), spoof(), spoof({ eyesClosed: true }), spoof()], spoof())
    const err = await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 2000, now: s.now, wait: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ScanTimeout)
    expect((err as ScanTimeout).checks.real).toBe(false)
    expect((err as Error).message).toMatch(/liveness/i)
  })

  it('rejects a still photograph the liveness model scores as static, even if it blinks', async () => {
    const still = (o: Partial<FaceReading> = {}) => live({ live: 0.15, ...o })
    const s = scripted([still(), still(), still({ eyesClosed: true }), still()], still())
    const err = await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 2000, now: s.now, wait: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ScanTimeout)
    expect((err as ScanTimeout).checks.live).toBe(false)
    expect((err as Error).message).toMatch(/not a photo/i)
  })

  it('a live face cannot vouch for a photo swapped in after it', async () => {
    // Live for a while, the face leaves, then a printed face (anti-spoof low) appears.
    const print = (o: Partial<FaceReading> = {}) => live({ real: 0.1, ...o })
    const s = scripted([live(), live(), live(), nobody, print(), print({ eyesClosed: true }), print()], print())
    const err = await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 2000, now: s.now, wait: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ScanTimeout)
    expect((err as ScanTimeout).checks.real).toBe(false)
  })

  it('refuses two faces in frame', async () => {
    const s = scripted([], live({ faces: 2 }))
    const err = await scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 1000, now: s.now, wait: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(ScanTimeout)
    expect((err as ScanTimeout).checks.oneFace).toBe(false)
  })

  it('treats eyes held shut as not a blink', async () => {
    const shut = Array.from({ length: 30 }, () => live({ eyesClosed: true }))
    const s = scripted([live(), ...shut], live())
    await expect(scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 3000, now: s.now, wait: async () => {} })).rejects.toThrow(/blink/i)
  })

  it('enrolment collects several angles, not just one', async () => {
    // After the blink, the head drifts centre → left → right and round again.
    const s = scripted(blink)
    const turns = ['center', 'center', 'center', 'left', 'left', 'left', 'right', 'right', 'right'] as const
    let n = 0
    const read = async () => {
      const r = await s.read()
      return r === blink.at(-1) || n > 0 ? live({ facing: turns[n++ % turns.length] }) : r
    }
    const r = await scanFace(read, video, { poses: { center: 4, left: 2, right: 2 }, timeoutMs: 20_000, now: s.now, wait: async () => {} })
    expect(r.byPose.center).toHaveLength(4)
    expect(r.byPose.left).toHaveLength(2)
    expect(r.byPose.right).toHaveLength(2)
  })

  it('stops promptly when cancelled', async () => {
    const ac = new AbortController()
    const s = scripted([], nobody)
    const p = scanFace(s.read, video, { poses: { center: 3 }, timeoutMs: 60_000, signal: ac.signal, now: s.now, wait: async () => ac.abort() })
    await expect(p).rejects.toBeInstanceOf(ScanAborted)
  })

  it('averages descriptors element-wise', () => {
    expect(averageDescriptor([[0, 2], [2, 4]])).toEqual([1, 3])
  })
})
