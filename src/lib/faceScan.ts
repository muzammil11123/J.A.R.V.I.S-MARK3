import type { FaceReader, FaceReading } from './face'

/**
 * What a run of face readings adds up to.
 *
 * A single frame proves very little. A face in a photograph is detected, and
 * described, exactly as well as a face in a chair — so finding a face is never
 * treated as knowing whose it is, and knowing whose it is is never trusted
 * from one frame. The scan holds out for all of these before it hands over a
 * descriptor:
 *
 *   one face        a second person in frame is refused, not ignored
 *   size, clarity   a small or uncertain face describes badly
 *   real            the anti-spoof model says this is not a print or screen
 *   live            the liveness model says this is not a still image
 *   a blink         eyes seen shut and then open again, at blink speed —
 *                   something a held-up photo cannot do
 *
 * Descriptors are only taken from frames facing the camera with the eyes
 * open, because those are the frames the descriptor model is good at. For
 * enrolment, a few are also taken turned to each side, so the template
 * covers more than one pose.
 *
 * The thresholds are the ones Human's own face-ID demo uses. Liveness is
 * "where supported" in the honest sense: these models raise the bar against
 * photos and simple replays; they are not certified anti-spoofing, and a
 * determined attacker with a good video or a mask may still get through.
 *
 * Nothing here touches a camera, a GPU or the DOM. The reader is passed in,
 * which is what lets the tests drive it with scripted faces.
 */

export const GATES = {
  minConfidence: 0.6,
  minSize: 140,
  minReal: 0.6,
  minLive: 0.6,
  /** A blink is a closed spell this long, in ms. Shorter is noise; longer is
   *  eyes held shut, which a photo with closed eyes could also manage. */
  blinkMin: 10,
  blinkMax: 800,
  /** Liveness scores are averaged over this many frames to stop flicker. */
  smoothing: 5,
  /** Gap between descriptor samples, so they are not near-copies. */
  sampleGapMs: 150,
}

export type Checks = {
  oneFace: boolean
  size: boolean
  confidence: boolean
  real: boolean
  live: boolean
  blink: boolean
}

export type ScanProgress = {
  /** searching = no usable face yet; detected = a face is there; collecting
   *  = every check has passed and descriptors are being taken. */
  stage: 'searching' | 'detected' | 'collecting'
  reading: FaceReading | null
  checks: Checks
  hint: string
  collected: number
  needed: number
}

export type Pose = 'center' | 'left' | 'right'

export type ScanOptions = {
  /** How many descriptors of each pose to collect. */
  poses: Partial<Record<Pose, number>>
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

export type ScanResult = { samples: number[][]; byPose: Record<Pose, number[][]> }

export class ScanTimeout extends Error {
  checks: Checks
  constructor(checks: Checks) {
    super(
      !checks.oneFace
        ? 'No single face was held in view long enough.'
        : !checks.real || !checks.live
          ? 'The liveness check did not pass. Use a live face in good light — not a photo or a screen.'
          : !checks.blink
            ? 'No blink was seen. Look at the camera and blink naturally.'
            : 'The face was not clear enough. Move closer, face the light, and hold still.',
    )
    this.checks = checks
    this.name = 'ScanTimeout'
  }
}

export class ScanAborted extends Error {
  constructor() {
    super('cancelled')
    this.name = 'ScanAborted'
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** The element-wise mean of several descriptors: steadier than any one frame. */
export function averageDescriptor(samples: number[][]): number[] {
  const out = new Array<number>(samples[0].length).fill(0)
  for (const s of samples) for (let i = 0; i < s.length; i++) out[i] += s[i] / samples.length
  return out
}

function hintFor(r: FaceReading | null, c: Checks, pose: Pose | null): string {
  if (!r || r.faces === 0) return 'Look at the camera.'
  if (!c.oneFace) return 'Only one face in view, please.'
  if (!c.size) return 'Move a little closer.'
  if (!c.confidence) return 'Face the light and hold still.'
  if (!c.real || !c.live) return 'Checking liveness…'
  if (!c.blink) return 'Blink once, naturally.'
  if (pose === 'left' || pose === 'right') return 'Turn your head slightly to one side, then the other.'
  return 'Hold still…'
}

/**
 * Read frames until every check has passed and enough descriptors are in, or
 * the time runs out. Throws ScanTimeout with what was missing, or ScanAborted.
 */
export async function scanFace(read: FaceReader, video: HTMLVideoElement, opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? (() => performance.now())
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const want: Record<Pose, number> = { center: opts.poses.center ?? 0, left: opts.poses.left ?? 0, right: opts.poses.right ?? 0 }
  const needed = want.center + want.left + want.right
  const byPose: Record<Pose, number[][]> = { center: [], left: [], right: [] }

  const started = now()
  const reals: number[] = []
  const lives: number[] = []
  let closedAt = 0
  let blinked = false
  let lastSample = -Infinity
  let checks: Checks = { oneFace: false, size: false, confidence: false, real: false, live: false, blink: false }

  const outstanding = (): Pose | null =>
    byPose.center.length < want.center ? 'center' : byPose.left.length < want.left || byPose.right.length < want.right ? 'left' : null

  for (;;) {
    if (opts.signal?.aborted) throw new ScanAborted()
    if (now() - started > opts.timeoutMs) throw new ScanTimeout(checks)

    const r = await read(video)
    if (opts.signal?.aborted) throw new ScanAborted()
    const t = now()

    if (r.faces === 1) {
      reals.push(r.real)
      lives.push(r.live)
      if (reals.length > GATES.smoothing) reals.shift()
      if (lives.length > GATES.smoothing) lives.shift()
      if (r.eyesClosed) {
        if (!closedAt) closedAt = t
      } else if (closedAt) {
        const spell = t - closedAt
        if (spell >= GATES.blinkMin && spell <= GATES.blinkMax) blinked = true
        closedAt = 0
      }
    } else {
      // Someone else stepping in, or the face leaving, starts liveness over.
      // Otherwise a live face could vouch for a photo swapped in after it.
      reals.length = 0
      lives.length = 0
      closedAt = 0
    }

    checks = {
      oneFace: r.faces === 1,
      size: r.faces === 1 && r.size >= GATES.minSize,
      confidence: r.faces === 1 && r.confidence >= GATES.minConfidence,
      real: reals.length >= Math.min(3, GATES.smoothing) && mean(reals) >= GATES.minReal,
      live: lives.length >= Math.min(3, GATES.smoothing) && mean(lives) >= GATES.minLive,
      blink: blinked,
    }
    const allOk = Object.values(checks).every(Boolean)

    if (allOk && r.embedding && !r.eyesClosed && t - lastSample >= GATES.sampleGapMs) {
      const pose = r.facing
      if (pose === 'center' && byPose.center.length < want.center) {
        byPose.center.push(r.embedding)
        lastSample = t
      } else if ((pose === 'left' || pose === 'right') && byPose[pose].length < want[pose]) {
        byPose[pose].push(r.embedding)
        lastSample = t
      }
    }

    const collected = byPose.center.length + byPose.left.length + byPose.right.length
    opts.onProgress?.({
      stage: allOk ? 'collecting' : r.faces > 0 ? 'detected' : 'searching',
      reading: r,
      checks,
      hint: hintFor(r, checks, outstanding()),
      collected,
      needed,
    })
    if (collected >= needed) return { samples: [...byPose.center, ...byPose.left, ...byPose.right], byPose }
    await wait(30)
  }
}
