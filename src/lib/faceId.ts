import { useStore, type FaceIdView } from '../store'
import type { IdentifyResult } from './bridge'
import * as camera from './camera'
import { loadFaceReader, type FaceReader } from './face'
import { averageDescriptor, scanFace, ScanAborted, ScanTimeout, type Pose } from './faceScan'
import * as identity from './identity'
import { getSettings } from './settings'

/**
 * The face popup, start to finish.
 *
 *   verify:  camera → models → face → checks → recognising → verdict
 *   enroll:  consent → camera → models → face from three angles → PIN → stored
 *
 * The camera is held only while frames are actually being read, through the
 * same refcounted handle as hand tracking and "look at this", so the popup
 * never opens a second stream and never takes the picture away from anything
 * else. It is released the moment the scan has what it needs — before the
 * bridge is even asked — and on every way out: success, failure, Cancel.
 *
 * Nothing here touches the microphone or the conversation. The voice loop
 * keeps running while the popup is open, and a command spoken meanwhile is
 * handled as usual.
 */

/** Face attempts per popup. After that, the PIN or close and come back. The
 *  bridge has its own, stricter lockout behind this one. */
export const MAX_ATTEMPTS = 3
export const VERIFY_TIMEOUT_MS = 20_000
export const ENROLL_TIMEOUT_MS = 45_000
/** Long enough to read "Welcome back", short enough not to be in the way. */
export const CLOSE_AFTER_MS = 1800
/** A camera that has not opened by now is waiting on a prompt nobody is
 *  answering, or a driver that has hung. */
export const CAMERA_TIMEOUT_MS = 30_000

const VERIFY_POSES: Partial<Record<Pose, number>> = { center: 3 }
const ENROLL_POSES: Partial<Record<Pose, number>> = { center: 4, left: 2, right: 2 }

export type FaceIdDeps = {
  holdCamera: () => Promise<HTMLVideoElement>
  releaseCamera: () => void
  loadReader: () => Promise<FaceReader>
  status: () => Promise<identity.IdentityStatus>
  verifyFace: (embedding: number[]) => Promise<identity.Verdict>
  verifyPin: (pin: string) => Promise<identity.Verdict>
  enrollFace: (samples: number[][], auth: { pin?: string; newPin?: string }, who: { name: string; photos: string[] }) => Promise<unknown>
  /** Passed to the scanner; tests replace it to run without real time. */
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

const realDeps: FaceIdDeps = {
  holdCamera: camera.holdCamera,
  releaseCamera: camera.releaseCamera,
  loadReader: loadFaceReader,
  status: identity.identityStatus,
  verifyFace: identity.verifyFace,
  verifyPin: identity.verifyPin,
  enrollFace: identity.enrollFace,
}

let deps = realDeps
/** For tests: swap the camera, the models and the bridge for fakes. */
export function setFaceIdDeps(d: Partial<FaceIdDeps> | null) {
  deps = d ? { ...realDeps, ...d } : realDeps
}

let run: AbortController | null = null
/** The scan currently holding the camera, if any. */
let held: AbortController | null = null
let pendingSamples: number[][] | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

const store = () => useStore.getState()
const patch = (p: Partial<FaceIdView>) => store().patchFaceId(p)

/** What JARVIS says when the face does not match, or the scan cannot finish. */
export const NOT_RECOGNISED = "I couldn't recognise you. Please try again or use your PIN."

/**
 * "Who am I", asked by voice. The bare question, any capitalisation, with or
 * without a question mark — and repeated, because the recogniser sometimes
 * hands over "who am I who am I" for one utterance.
 */
const WHO_AM_I = /^(?:\s*(?:who am i|who is this|do you (?:know|recogni[sz]e) me|recogni[sz]e me|identify me|verify me|scan my face)[\s?.!,]*)+$/i
export const isWhoAmI = (text: string) => WHO_AM_I.test(text.trim())

/**
 * The sentence to speak for an outcome. The name is used only on a face
 * match — a PIN proves who is at the keyboard, but is not recognition.
 */
export function whoAmIReply(r: IdentifyResult): string {
  if (r.verified && r.method === 'face') return r.name ? `Welcome back, ${r.name}.` : 'Welcome back. Your face is recognised, but no name is saved yet.'
  if (r.verified) return 'Identity verified by PIN.'
  switch (r.reason) {
    case 'not-enrolled':
      return 'No face is enrolled yet. Please enrol your face first.'
    case 'disabled':
      return 'Face recognition is switched off. Turn it on in the console, under identity.'
    case 'camera':
    case 'locked':
    case 'unavailable':
      return r.error ?? NOT_RECOGNISED
    default:
      return NOT_RECOGNISED
  }
}

/**
 * A "who am I" waiting on this popup's outcome. Settled once, by the first
 * outcome: a match, a no-match, a scan that could not finish, or the popup
 * closing. The popup itself stays up after a failure, so Retry and Use PIN are
 * still there — the spoken answer just does not wait for them.
 */
let identifyWaiter: ((r: IdentifyResult) => void) | null = null
function settleIdentify(r: IdentifyResult) {
  const w = identifyWaiter
  identifyWaiter = null
  w?.({ ...r, say: whoAmIReply(r) })
}

/** Open the face check for JARVIS and resolve with who it found. Never rejects. */
export function identifyMe(): Promise<IdentifyResult> {
  if (!getSettings().faceId) {
    const r: IdentifyResult = { verified: false, reason: 'disabled', error: 'Face recognition is switched off.' }
    return Promise.resolve({ ...r, say: whoAmIReply(r) })
  }
  // One popup, one camera hold: a second "who am I" replaces the first.
  if (store().faceId) closeFaceId()
  return new Promise((resolve) => {
    identifyWaiter = resolve
    openFaceId('verify')
    const v = store().faceId
    if (v?.stage === 'error') settleIdentify({ verified: false, reason: 'unavailable', error: v.hint })
  })
}

/** Stop with a reason, and tell a waiting "who am I" — nothing more will happen. */
function stop(hint: string, reason: IdentifyResult['reason'] = 'unavailable') {
  patch({ stage: 'error', hint, box: null })
  settleIdentify({ verified: false, reason, error: hint })
}

/**
 * One picture of the face, cropped around it with some margin and mirrored
 * the way the preview shows it. Small on purpose: it is for recognising the
 * enrolment at a glance, not for matching.
 */
const PHOTO_WIDTH = 240
function snapshot(video: HTMLVideoElement, box: [number, number, number, number]): string | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null
  const pad = 0.35
  const sx = Math.max(0, (box[0] - box[2] * pad) * vw)
  const sy = Math.max(0, (box[1] - box[3] * pad) * vh)
  const sw = Math.min(vw - sx, box[2] * (1 + 2 * pad) * vw)
  const sh = Math.min(vh - sy, box[3] * (1 + 2 * pad) * vh)
  if (sw < 8 || sh < 8) return null
  // A missed picture must never cost the enrolment itself.
  try {
    const c = document.createElement('canvas')
    c.width = PHOTO_WIDTH
    c.height = Math.round((PHOTO_WIDTH * sh) / sw)
    const g = c.getContext('2d')
    if (!g) return null
    g.translate(c.width, 0)
    g.scale(-1, 1)
    g.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.82)
  } catch {
    return null
  }
}

/**
 * Give back the camera hold. A scan passes its own controller and only ever
 * releases its own hold: a replaced scan's clean-up can run after the next
 * scan has taken the camera, and must not take it away from it. Close and
 * Use PIN pass nothing and release whichever scan holds it.
 */
function release(owner?: AbortController) {
  if (!held) return
  if (owner && held !== owner) return
  held = null
  deps.releaseCamera()
}

/** Plain words for the ways a camera fails to open. */
export function cameraProblem(err: unknown): string {
  const name = (err as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was denied. Allow the camera for JARVIS (Windows Settings › Privacy › Camera, and the browser’s site permissions), then retry — or use your PIN.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Connect one and retry, or use your PIN.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'The camera is busy in another app. Close it and retry, or use your PIN.'
  }
  if (name === 'TimeoutError') return 'The camera did not start. Check it is connected and not in use, then retry.'
  return `The camera could not be started: ${(err as Error)?.message ?? err}`
}

/**
 * Hold the camera, or give up after CAMERA_TIMEOUT_MS.
 *
 * Giving up hands the hold back at once. The camera module counts a hold from
 * the moment it is asked for, so a request that never answers — a permission
 * prompt nobody sees, a hung driver — would otherwise keep the count up for
 * good, and the camera could never be closed by anyone again. If the request
 * does land later, its stream is closed unless something else is using it by
 * then; either way the light does not stay on with nobody using it.
 */
async function holdWithTimeout(owner: AbortController): Promise<HTMLVideoElement> {
  const signal = owner.signal
  let settled = false
  let pending = true
  let gaveBack = false
  const hold = deps.holdCamera().then(
    (v) => {
      pending = false
      if (settled && !gaveBack) deps.releaseCamera()
      else if (settled && gaveBack && camera.diag.holders === 0) deps.releaseCamera()
      return v
    },
    (err) => {
      pending = false
      throw err
    },
  )
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('camera timeout'), { name: 'TimeoutError' })), CAMERA_TIMEOUT_MS)
    hold.finally(() => clearTimeout(t)).catch(() => {})
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new ScanAborted())
    })
  })
  try {
    const v = await Promise.race([hold, timeout])
    held = owner
    return v
  } catch (err) {
    if (pending) {
      gaveBack = true
      deps.releaseCamera()
    }
    throw err
  } finally {
    settled = true
  }
}

function blank(mode: FaceIdView['mode'], stage: FaceIdView['stage']): FaceIdView {
  return { mode, stage, hint: '', box: null, progress: 0, attempts: 0, score: null }
}

/**
 * Open the popup. A second call while it is open does nothing: one popup, one
 * camera hold.
 */
export function openFaceId(mode: FaceIdView['mode'] = 'verify') {
  if (store().faceId) return
  if (!identity.identityAvailable) {
    store().setFaceId({ ...blank(mode, 'error'), hint: 'Face recognition needs the JARVIS bridge, which keeps the face template encrypted. Start JARVIS with npm start.' })
    return
  }
  if (mode === 'enroll') {
    store().setFaceId(blank('enroll', 'consent'))
    return
  }
  store().setFaceId({ ...blank('verify', 'camera'), hint: 'Initializing camera…' })
  void (async () => {
    try {
      const s = await deps.status()
      if (!store().faceId) return
      if (!s.face.enrolled) {
        stop('No face is enrolled yet. Enrol yours first.', 'not-enrolled')
        return
      }
      if (s.locked_for_ms > 0) {
        stop(`Too many failed attempts. Try again in ${Math.ceil(s.locked_for_ms / 1000)} s.`, 'locked')
        return
      }
    } catch (err) {
      stop(`The bridge is not reachable (${(err as Error)?.message ?? err}).`)
      return
    }
    await scan()
  })()
}

/** Enrolment: the person has read what is stored and agreed. */
export function giveConsent() {
  if (store().faceId?.stage !== 'consent') return
  void scan()
}

export function retry() {
  const v = store().faceId
  if (!v || v.attempts >= MAX_ATTEMPTS) return
  void scan()
}

/** The manual fallback. The camera goes off; it is not needed for a PIN. */
export function usePin() {
  if (!store().faceId) return
  run?.abort()
  release()
  patch({ stage: 'pin', hint: 'Enter your PIN.', box: null })
}

/**
 * The PIN step. In verify mode it IS the check; in enrol mode it authorises
 * storing the samples and pictures just taken, under the name given (or, the
 * first time, chooses the PIN).
 */
export async function submitPin(pin: string, newPin?: string, name = '') {
  const v = store().faceId
  if (!v) return
  try {
    if (v.mode === 'verify') {
      const r = await deps.verifyPin(pin)
      if (!store().faceId) return
      if (r.verified) return succeed('pin', null, null)
      patch({ hint: r.locked_for_ms ? `Too many failed attempts. Try again in ${Math.ceil(r.locked_for_ms / 1000)} s.` : (r.error ?? 'That PIN is not correct.') })
      return
    }
    if (!pendingSamples) return
    const who = name.trim()
    if (!who) {
      patch({ hint: 'Type your name first, so I know who this face is.' })
      return
    }
    await deps.enrollFace(pendingSamples, newPin ? { newPin } : { pin }, { name: who, photos: v.photos ?? [] })
    pendingSamples = null
    if (!store().faceId) return
    patch({ stage: 'enrolled', name: who, hint: `Face enrolled as ${who}. Now ask me "who am I?"` })
    closeTimer = setTimeout(closeFaceId, CLOSE_AFTER_MS + 600)
  } catch (err) {
    patch({ hint: (err as Error)?.message ?? String(err) })
  }
}

/** Cancel, Close, Escape, or the automatic close after success. */
export function closeFaceId() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  run?.abort()
  run = null
  release()
  // Enrolment samples never outlive the popup they were taken in.
  pendingSamples = null
  store().setFaceId(null)
  settleIdentify({ verified: false, reason: 'closed', error: 'The face check was closed before it finished.' })
}

/**
 * A verdict of yes. `name` is passed only for a face match; a PIN success
 * never carries it, so nothing on screen or spoken uses the name without one.
 */
function succeed(method: 'face' | 'pin', score: number | null, name: string | null, personality = '') {
  store().setIdentity({ method, at: Date.now(), name })
  const hint = name ? `Welcome back, ${name}. Identity verified.` : method === 'face' ? 'Welcome back. Identity verified.' : 'Identity verified.'
  patch({ stage: 'verified', name, hint, score, box: null })
  settleIdentify({ verified: true, method, ...(method === 'face' ? { name, personality } : {}) })
  closeTimer = setTimeout(closeFaceId, CLOSE_AFTER_MS)
}

async function scan() {
  const v = store().faceId
  if (!v) return
  run?.abort()
  const ac = new AbortController()
  run = ac
  const enrolling = v.mode === 'enroll'
  patch({ stage: 'camera', hint: 'Initializing camera…', attempts: v.attempts + 1, box: null, progress: 0, score: null, photos: [] })

  // Enrolment takes one picture per pose — straight on, then turned each way —
  // and only once every liveness check has passed, so they are of a live face.
  const shots: Partial<Record<'center' | 'left' | 'right', string>> = {}

  try {
    const video = await holdWithTimeout(ac)
    if (ac.signal.aborted) throw new ScanAborted()
    patch({ stage: 'loading', hint: 'Loading face models…' })
    const read = await deps.loadReader()
    patch({ stage: 'searching', hint: 'Look at the camera.' })

    const result = await scanFace(read, video, {
      poses: enrolling ? ENROLL_POSES : VERIFY_POSES,
      timeoutMs: enrolling ? ENROLL_TIMEOUT_MS : VERIFY_TIMEOUT_MS,
      signal: ac.signal,
      wait: deps.wait,
      now: deps.now,
      onProgress: (p) => {
        const r = p.reading
        let photos: string[] | undefined
        if (enrolling && p.stage === 'collecting' && r?.faces === 1 && r.box && r.facing && !shots[r.facing]) {
          const shot = snapshot(video, r.box)
          if (shot) {
            shots[r.facing] = shot
            photos = (['center', 'left', 'right'] as const).flatMap((k) => (shots[k] ? [shots[k]] : []))
          }
        }
        patch({
          stage: p.stage === 'searching' ? 'searching' : 'detected',
          hint: p.stage === 'searching' ? p.hint : p.stage === 'collecting' ? p.hint : `Face detected. ${p.hint}`,
          box: r?.faces === 1 ? r.box : null,
          progress: p.needed ? p.collected / p.needed : 0,
          ...(photos ? { photos } : {}),
        })
      },
    })
    // Got what we came for. The camera goes off before anything else happens.
    release(ac)
    if (ac.signal.aborted) throw new ScanAborted()

    if (enrolling) {
      pendingSamples = result.samples
      const n = store().faceId?.photos?.length ?? 0
      patch({ stage: 'captured', hint: `${n} picture${n === 1 ? '' : 's'} of your face taken. Type your name, then your PIN to save.`, box: null, progress: 1 })
      return
    }

    patch({ stage: 'recognizing', hint: 'Recognizing…', box: null, progress: 1 })
    const verdict = await deps.verifyFace(averageDescriptor(result.samples))
    if (ac.signal.aborted || !store().faceId) return
    if (verdict.verified) return succeed('face', verdict.score ?? null, verdict.name ?? null, verdict.personality ?? '')
    if (verdict.locked_for_ms) {
      stop(`Too many failed attempts. Try again in ${Math.ceil(verdict.locked_for_ms / 1000)} s, or use your PIN later.`, 'locked')
      return
    }
    if (verdict.error) {
      stop(verdict.error, /enrol/i.test(verdict.error) ? 'not-enrolled' : 'unavailable')
      return
    }
    const left = MAX_ATTEMPTS - (store().faceId?.attempts ?? MAX_ATTEMPTS)
    patch({
      stage: 'rejected',
      score: verdict.score ?? null,
      hint: left > 0 ? `Face not recognized. ${left} ${left === 1 ? 'try' : 'tries'} left, or use your PIN.` : 'Face not recognized. Use your PIN instead.',
    })
    // The popup keeps Retry and Use PIN; a spoken "who am I" answers now.
    settleIdentify({ verified: false, reason: 'no-match', error: 'The face did not match the enrolled one.' })
  } catch (err) {
    release(ac)
    if (err instanceof ScanAborted || ac.signal.aborted) return
    if (err instanceof ScanTimeout) {
      stop(err.message, 'timeout')
      return
    }
    const name = (err as DOMException)?.name
    const isCamera = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError', 'TrackStartError', 'AbortError', 'TimeoutError', 'DevicesNotFoundError'].includes(name)
    stop(isCamera ? cameraProblem(err) : ((err as Error)?.message ?? String(err)), isCamera ? 'camera' : 'unavailable')
  } finally {
    if (run === ac) run = null
  }
}
