import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import * as camera from './camera'
import type { FaceReading } from './face'
import type { IdentityStatus, Verdict } from './identity'
import { setSettings } from './settings'
import {
  CAMERA_TIMEOUT_MS,
  CLOSE_AFTER_MS,
  MAX_ATTEMPTS,
  NOT_RECOGNISED,
  closeFaceId,
  giveConsent,
  identifyMe,
  isWhoAmI,
  openFaceId,
  retry,
  setFaceIdDeps,
  submitPin,
  usePin,
} from './faceId'

/**
 * The face popup end to end, with every device faked: getUserMedia hands back
 * a fake stream whose tracks record being stopped, the models are a scripted
 * reader, and the bridge is a set of stubs. The real shared camera module is
 * used, so "the camera was released" is checked on the tracks themselves.
 */

type Track = { kind: string; stopped: boolean; stop: () => void }
let tracks: Track[] = []
let gum: ReturnType<typeof vi.fn>

function fakeDevices(fail?: string) {
  tracks = []
  gum = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (fail) throw Object.assign(new Error(fail), { name: fail })
    const t: Track = { kind: 'video', stopped: false, stop() { this.stopped = true } }
    tracks.push(t)
    return { getTracks: () => [t], constraints } as unknown as MediaStream
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } })
  vi.stubGlobal('document', {
    createElement: () => ({ play: async () => {}, pause: () => {}, srcObject: null, videoWidth: 1280 }),
  })
}

const emb = new Array(1024).fill(0.1)
const live = (o: Partial<FaceReading> = {}): FaceReading => ({
  faces: 1, box: [0.4, 0.3, 0.2, 0.3], size: 220, confidence: 0.9, real: 0.9, live: 0.9,
  facing: 'center', eyesClosed: false, embedding: emb, ...o,
})
const nobody = live({ faces: 0, box: null, embedding: null, real: 0, live: 0 })
/** An empty room, one frame per tick, as a real camera paces it — so a test
 *  can act mid-scan before the fake clock runs the scan out. */
const emptyRoom = async () => {
  await new Promise((r) => setImmediate(r))
  return nobody
}

/** A face that blinks, then turns through the poses enrolment asks for. */
function person() {
  const seq = [live(), live(), live({ eyesClosed: true }), live({ eyesClosed: true })]
  const turns = ['center', 'center', 'left', 'left', 'right', 'right'] as const
  let i = 0
  return async () => (i < seq.length ? seq[i++] : live({ facing: turns[i++ % turns.length] }))
}

const status = (o: Partial<IdentityStatus> = {}): IdentityStatus => ({
  face: { enrolled: true, at: '2026-10-30T00:00:00Z', samples: 8 },
  pin: true, threshold: 0.5, locked_for_ms: 0, session: null, encrypted_at_rest: true, ...o,
})

let clock = 0
function deps(o: { read?: () => Promise<FaceReading>; verdict?: Verdict; st?: IdentityStatus; pin?: string } = {}) {
  const verifyFace = vi.fn(async () => o.verdict ?? { verified: true, score: 0.82, threshold: 0.5 })
  const verifyPin = vi.fn(async (pin: string) => ({ verified: pin === (o.pin ?? '4821') }))
  const enrollFace = vi.fn(async () => ({ enrolled: true }))
  const st = vi.fn(async () => o.st ?? status())
  setFaceIdDeps({
    loadReader: async () => o.read ?? person(),
    status: st,
    verifyFace,
    verifyPin,
    enrollFace,
    // Each frame advances a fake clock; no real waiting anywhere.
    now: () => (clock += 50),
    wait: async () => {},
  })
  return { verifyFace, verifyPin, enrollFace, status: st }
}

/** Let the controller's async chain run until `pred` holds. */
async function until(pred: () => boolean, what = 'condition') {
  for (let i = 0; i < 5000; i++) {
    if (pred()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${what}; stage=${useStore.getState().faceId?.stage}`)
}
const stage = () => useStore.getState().faceId?.stage
const cameraOff = () => tracks.every((t) => t.stopped) && camera.diag.holders === 0 && !camera.cameraLive()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fakeDevices()
  useStore.setState({ faceId: null, identity: null, phase: 'dormant' })
})
afterEach(() => {
  closeFaceId()
  setFaceIdDeps(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('face verification popup', () => {
  it('verifies, says so, releases the camera and closes itself', async () => {
    const d = deps()
    openFaceId('verify')
    expect(stage()).toBe('camera') // Initializing camera…
    await until(() => stage() === 'verified', 'verified')

    expect(useStore.getState().faceId?.hint).toBe('Welcome back. Identity verified.')
    expect(useStore.getState().identity?.method).toBe('face')
    expect(d.verifyFace).toHaveBeenCalledTimes(1)
    // Released before the verdict, not when the popup goes.
    expect(cameraOff()).toBe(true)

    vi.advanceTimersByTime(CLOSE_AFTER_MS)
    expect(useStore.getState().faceId).toBeNull()
  })

  it('returns to the JARVIS interface untouched: phase and conversation as they were', async () => {
    deps()
    useStore.setState({ phase: 'listening', turns: [{ id: 't1', role: 'user', text: 'what time is it' }] })
    openFaceId('verify')
    await until(() => stage() === 'verified')
    vi.advanceTimersByTime(CLOSE_AFTER_MS)
    const s = useStore.getState()
    expect(s.faceId).toBeNull()
    expect(s.phase).toBe('listening')
    expect(s.turns).toHaveLength(1)
  })

  it('rejects an unknown face, keeps the popup open and offers a retry', async () => {
    deps({ verdict: { verified: false, score: 0.21, threshold: 0.5 } })
    openFaceId('verify')
    await until(() => stage() === 'rejected', 'rejected')
    const v = useStore.getState().faceId!
    expect(v.score).toBe(0.21)
    expect(v.hint).toMatch(/not recognized/i)
    expect(useStore.getState().identity).toBeNull()
    expect(cameraOff()).toBe(true)
    vi.advanceTimersByTime(CLOSE_AFTER_MS * 3)
    expect(useStore.getState().faceId).not.toBeNull() // no auto-close on failure
  })

  it(`stops offering face retries after ${MAX_ATTEMPTS} attempts`, async () => {
    const d = deps({ verdict: { verified: false, score: 0.2 } })
    openFaceId('verify')
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await until(() => stage() === 'rejected' && useStore.getState().faceId!.attempts === i, `attempt ${i}`)
      if (i < MAX_ATTEMPTS) retry()
    }
    retry() // one too many: ignored
    await new Promise((r) => setImmediate(r))
    expect(stage()).toBe('rejected')
    expect(d.verifyFace).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(useStore.getState().faceId!.hint).toMatch(/PIN/)
  })

  it('falls back to the PIN, which turns the camera off and verifies', async () => {
    deps({ read: emptyRoom })
    openFaceId('verify')
    await until(() => stage() === 'searching')
    usePin()
    expect(stage()).toBe('pin')
    expect(cameraOff()).toBe(true)
    await submitPin('0000')
    expect(stage()).toBe('pin')
    await submitPin('4821')
    expect(stage()).toBe('verified')
    expect(useStore.getState().identity?.method).toBe('pin')
    vi.advanceTimersByTime(CLOSE_AFTER_MS)
    expect(useStore.getState().faceId).toBeNull()
  })

  it('reports a denied camera permission plainly and holds nothing', async () => {
    fakeDevices('NotAllowedError')
    deps()
    openFaceId('verify')
    await until(() => stage() === 'error')
    expect(useStore.getState().faceId!.hint).toMatch(/denied/i)
    expect(camera.diag.holders).toBe(0)
  })

  it('reports a missing camera', async () => {
    fakeDevices('NotFoundError')
    deps()
    openFaceId('verify')
    await until(() => stage() === 'error')
    expect(useStore.getState().faceId!.hint).toMatch(/no camera/i)
  })

  it('reports a camera busy in another app', async () => {
    fakeDevices('NotReadableError')
    deps()
    openFaceId('verify')
    await until(() => stage() === 'error')
    expect(useStore.getState().faceId!.hint).toMatch(/busy/i)
  })

  it('times out when no usable face appears, and lets go of the camera', async () => {
    deps({ read: async () => nobody })
    openFaceId('verify')
    await until(() => stage() === 'error', 'timeout')
    expect(useStore.getState().faceId!.hint).toMatch(/single face/i)
    expect(cameraOff()).toBe(true)
  })

  it('Cancel mid-scan closes the popup and turns the camera off', async () => {
    deps({ read: emptyRoom })
    openFaceId('verify')
    await until(() => stage() === 'searching')
    expect(camera.cameraLive()).toBe(true)
    closeFaceId()
    expect(useStore.getState().faceId).toBeNull()
    expect(cameraOff()).toBe(true)
  })

  it('opening twice never opens a second camera stream', async () => {
    deps({ read: emptyRoom })
    openFaceId('verify')
    openFaceId('verify')
    await until(() => stage() === 'searching')
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it('shares the stream with hand tracking and leaves it running for it', async () => {
    deps()
    await camera.holdCamera() // hand tracking already has the camera
    openFaceId('verify')
    await until(() => stage() === 'verified')
    expect(gum).toHaveBeenCalledTimes(1)
    expect(camera.cameraLive()).toBe(true)
    expect(camera.diag.holders).toBe(1)
    camera.releaseCamera()
    expect(cameraOff()).toBe(true)
  })

  it('never asks for the microphone', async () => {
    deps()
    openFaceId('verify')
    await until(() => stage() === 'verified')
    for (const [c] of gum.mock.calls) expect((c as MediaStreamConstraints).audio).toBeUndefined()
  })

  it('says so when no face is enrolled, without opening the camera', async () => {
    deps({ st: status({ face: { enrolled: false } }) })
    openFaceId('verify')
    await until(() => stage() === 'error')
    expect(useStore.getState().faceId!.hint).toMatch(/enrol/i)
    expect(gum).not.toHaveBeenCalled()
  })
})

describe('who am I', () => {
  it('recognises the spoken command, and only that', () => {
    for (const s of ['Who am I?', 'who am i', 'WHO AM I.', 'who am I who am I', '  who am I ?  ', 'do you recognise me', 'Do you know me?'])
      expect(isWhoAmI(s), s).toBe(true)
    for (const s of ['who am I talking to', 'tell me who I am meeting', 'who is Ayman', 'am I late'])
      expect(isWhoAmI(s), s).toBe(false)
  })

  it('a face match answers "Welcome back, <name>." and carries the profile note', async () => {
    deps({ verdict: { verified: true, score: 0.8, name: 'Ayman', personality: 'Likes short answers.' } })
    const r = await identifyMe()
    expect(r).toMatchObject({ verified: true, method: 'face', name: 'Ayman', personality: 'Likes short answers.' })
    expect(r.say).toBe('Welcome back, Ayman.')
    expect(useStore.getState().faceId?.hint).toMatch(/Ayman/)
    expect(cameraOff()).toBe(true)
  })

  it('a face that does not match answers the not-recognised sentence, without any name', async () => {
    deps({ verdict: { verified: false, score: 0.31, threshold: 0.5 } })
    const r = await identifyMe()
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('no-match')
    expect(r.say).toBe(NOT_RECOGNISED)
    expect(r.say).toBe("I couldn't recognise you. Please try again or use your PIN.")
    expect(r.name).toBeUndefined()
    // The popup stays, so Retry and Use PIN are still there.
    expect(stage()).toBe('rejected')
    expect(cameraOff()).toBe(true)
  })

  it('PIN 2006 verifies, but is never answered with the name', async () => {
    deps({ read: emptyRoom, pin: '2006' })
    const pending = identifyMe()
    await until(() => stage() === 'searching')
    usePin()
    expect(cameraOff()).toBe(true)
    await submitPin('2007')
    expect(stage()).toBe('pin')
    expect(useStore.getState().faceId!.hint).toMatch(/not correct/i)
    await submitPin('2006')
    const r = await pending
    expect(r).toMatchObject({ verified: true, method: 'pin' })
    expect(r.name).toBeUndefined()
    expect(r.say).toBe('Identity verified by PIN.')
    expect(useStore.getState().identity).toMatchObject({ method: 'pin', name: null })
  })

  it('a scan that times out (nobody, or a photo that never passes liveness) answers not-recognised', async () => {
    deps({ read: emptyRoom })
    const r = await identifyMe()
    expect(r.reason).toBe('timeout')
    expect(r.say).toBe(NOT_RECOGNISED)
    expect(cameraOff()).toBe(true)
  })

  it('a photo held up (no blink, low liveness) is not recognised', async () => {
    const photo = async () => {
      await new Promise((r) => setImmediate(r))
      return live({ live: 0.1, real: 0.2 })
    }
    const d = deps({ read: photo })
    const r = await identifyMe()
    expect(r.verified).toBe(false)
    expect(r.say).toBe(NOT_RECOGNISED)
    expect(d.verifyFace).not.toHaveBeenCalled()
  })

  it('a denied camera says why, plainly, and holds nothing', async () => {
    fakeDevices('NotAllowedError')
    deps()
    const r = await identifyMe()
    expect(r.reason).toBe('camera')
    expect(r.say).toMatch(/camera access was denied/i)
    expect(camera.diag.holders).toBe(0)
  })

  it('a missing camera says so', async () => {
    fakeDevices('NotFoundError')
    deps()
    const r = await identifyMe()
    expect(r.reason).toBe('camera')
    expect(r.say).toMatch(/no camera was found/i)
  })

  it('a camera that never opens gives up after the timeout', async () => {
    gum = vi.fn(() => new Promise<MediaStream>(() => {}))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } })
    deps()
    const pending = identifyMe()
    await until(() => gum.mock.calls.length > 0, 'camera requested')
    vi.advanceTimersByTime(CAMERA_TIMEOUT_MS + 1)
    const r = await pending
    expect(r.reason).toBe('camera')
    expect(r.say).toMatch(/did not start/i)
  })

  it('answers straight away when no face is enrolled, and never opens the camera', async () => {
    deps({ st: status({ face: { enrolled: false } }) })
    const r = await identifyMe()
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('not-enrolled')
    expect(r.say).toMatch(/enrol/i)
    expect(gum).not.toHaveBeenCalled()
  })

  it('respects face recognition being switched off', async () => {
    deps()
    setSettings({ faceId: false })
    try {
      const r = await identifyMe()
      expect(r.reason).toBe('disabled')
      expect(gum).not.toHaveBeenCalled()
    } finally {
      setSettings({ faceId: true })
    }
  })

  it('a second "who am I" replaces the first: one popup, one camera', async () => {
    deps({ read: emptyRoom })
    const first = identifyMe()
    await until(() => stage() === 'searching')
    const second = identifyMe()
    expect((await first).reason).toBe('closed')
    await until(() => stage() === 'searching')
    expect(camera.diag.holders).toBe(1)
    closeFaceId()
    await second
    expect(cameraOff()).toBe(true)
  })

  it('answers when the popup is closed before a verdict', async () => {
    deps({ read: emptyRoom })
    const pending = identifyMe()
    await until(() => stage() === 'searching')
    closeFaceId()
    const r = await pending
    expect(r.verified).toBe(false)
    expect(r.say).toBe(NOT_RECOGNISED)
  })
})

describe('face enrolment', () => {
  it('waits for consent before the camera comes on', () => {
    deps()
    openFaceId('enroll')
    expect(stage()).toBe('consent')
    expect(gum).not.toHaveBeenCalled()
  })

  it('captures several angles, releases the camera, and stores them only with a PIN', async () => {
    const d = deps({ st: status({ face: { enrolled: false }, pin: false }) })
    openFaceId('enroll')
    giveConsent()
    await until(() => stage() === 'captured', 'captured')
    expect(cameraOff()).toBe(true)
    expect(d.enrollFace).not.toHaveBeenCalled()

    await submitPin('', '4821', 'Ayman')
    const [samples, auth, who] = d.enrollFace.mock.calls[0] as unknown as [number[][], object, { name: string; photos: string[] }]
    expect(samples).toHaveLength(8)
    expect(auth).toEqual({ newPin: '4821' })
    expect(who.name).toBe('Ayman')
    expect(Array.isArray(who.photos)).toBe(true)
    expect(stage()).toBe('enrolled')
    vi.advanceTimersByTime(CLOSE_AFTER_MS + 600)
    expect(useStore.getState().faceId).toBeNull()
  })

  it('will not save a face without a name', async () => {
    const d = deps({ st: status({ face: { enrolled: false }, pin: false }) })
    openFaceId('enroll')
    giveConsent()
    await until(() => stage() === 'captured')
    await submitPin('', '4821', '   ')
    expect(d.enrollFace).not.toHaveBeenCalled()
    expect(useStore.getState().faceId!.hint).toMatch(/name/i)
  })

  it('drops the captured samples if the popup is closed before saving', async () => {
    const d = deps()
    openFaceId('enroll')
    giveConsent()
    await until(() => stage() === 'captured')
    closeFaceId()
    await submitPin('4821')
    expect(d.enrollFace).not.toHaveBeenCalled()
  })
})
