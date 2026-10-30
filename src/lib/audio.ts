import { getSettings } from './settings'

/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 *
 * It also owns the microphone's state as the rest of the app should see it:
 * which device, whether permission was refused, and whether it has been
 * unplugged. A pulled USB headset ends the track without any error anywhere,
 * so the track's own `ended` event is what reports it, and a `devicechange`
 * afterwards is the cue to try again.
 */

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null

export type MicState = {
  status: 'idle' | 'live' | 'denied' | 'missing' | 'lost'
  label: string
  deviceId: string
  /** The browser's permission state, where the Permissions API reports it. */
  permission: 'granted' | 'denied' | 'prompt' | 'unknown'
}

let micState: MicState = { status: 'idle', label: '', deviceId: '', permission: 'unknown' }
const micSubs = new Set<() => void>()

export const micStatus = (): MicState => micState
export function onMicStatus(fn: () => void): () => void {
  micSubs.add(fn)
  return () => micSubs.delete(fn)
}
function setMic(patch: Partial<MicState>) {
  micState = { ...micState, ...patch }
  micSubs.forEach((f) => f())
}

/** Asks the voice loop to rebuild itself on a new stream. App.tsx listens. */
const announceChange = () => window.dispatchEvent(new CustomEvent('jarvis:mic-changed'))

const CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export async function getMic(): Promise<MediaStream> {
  if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream
  stream = null
  const chosen = getSettings().micId
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: chosen ? { ...CONSTRAINTS, deviceId: { exact: chosen } } : CONSTRAINTS,
    })
  } catch (err) {
    const name = (err as DOMException)?.name
    // The chosen microphone is gone; the default one is better than none.
    if (chosen && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS }).catch((e) => {
        setMic({ status: e?.name === 'NotAllowedError' ? 'denied' : 'missing' })
        throw e
      })
    } else {
      setMic({ status: name === 'NotAllowedError' ? 'denied' : 'missing', permission: name === 'NotAllowedError' ? 'denied' : micState.permission })
      throw err
    }
  }
  const track = stream.getAudioTracks()[0]
  setMic({ status: 'live', label: track?.label ?? '', deviceId: track?.getSettings().deviceId ?? '', permission: 'granted' })
  track?.addEventListener('ended', () => {
    if (stream?.getAudioTracks()[0] !== track) return
    stream = null
    analyser = null
    setMic({ status: 'lost' })
  })
  return stream
}

/** Every microphone the browser will name. Labels need permission first. */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

/**
 * Drop the current stream and open the chosen one. The voice loop is told to
 * restart, since its audio graph is built on the old stream.
 */
export async function switchMic(): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  analyser = null
  try {
    await getMic()
    await startAnalyser()
  } finally {
    announceChange()
  }
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  // A microphone plugged back in, or a different one appearing after the
  // chosen one vanished: reopen and let the voice loop rebuild.
  navigator.mediaDevices.addEventListener?.('devicechange', () => {
    if (micState.status === 'lost' || micState.status === 'missing') void switchMic().catch(() => {})
  })
  void navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((p) => {
      setMic({ permission: p.state })
      p.onchange = () => setMic({ permission: p.state })
    })
    .catch(() => {})
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  const s = await getMic()
  ctx ??= new AudioContext()
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
