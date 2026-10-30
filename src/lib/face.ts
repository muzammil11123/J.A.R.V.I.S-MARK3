import type { Config, Human } from '@vladmandic/human'

/**
 * Faces, read on this machine.
 *
 * One job: turn a video frame into a plain reading — how many faces, where,
 * how sure, whether the eyes are shut, whether it looks like a live person
 * rather than a photo or a screen, and the 1024-number descriptor that the
 * bridge compares against the enrolled one. Deciding what a sequence of
 * readings means is faceScan.ts's job, so that it can be tested without a
 * camera or a GPU.
 *
 * Everything runs locally. The models are served from this app's own origin
 * (copied into public/human-models by scripts/start.mjs), so nothing is
 * fetched from anyone else's server and no frame leaves the page. Frames are
 * read and dropped; none is kept, encoded or sent.
 *
 * The library is imported lazily. It carries its own TensorFlow build, and a
 * person who never opens the face popup should not pay for it at start-up.
 */

export type FaceReading = {
  /** Faces in frame. Verification needs exactly one. */
  faces: number
  /** The face's box as fractions of the frame, unmirrored: x, y, w, h. */
  box: [number, number, number, number] | null
  /** Shorter side of the face box in pixels; small faces describe badly. */
  size: number
  confidence: number
  /** Anti-spoof model: 1 = a real face, 0 = a photo, print or screen. */
  real: number
  /** Liveness model: 1 = a living face, 0 = a static one. */
  live: number
  facing: 'center' | 'left' | 'right' | null
  /** Either eye shut this frame — half of a blink. */
  eyesClosed: boolean
  embedding: number[] | null
}

export type FaceReader = (video: HTMLVideoElement) => Promise<FaceReading>

const MODELS = '/human-models/'

const CONFIG: Partial<Config> = {
  modelBasePath: MODELS,
  backend: 'webgl',
  debug: false,
  warmup: 'none',
  // The cache returns the last result for frames that look similar, which is
  // exactly wrong for catching a blink. Every frame is read fresh.
  cacheSensitivity: 0,
  filter: { enabled: true, equalization: false, flip: false },
  face: {
    enabled: true,
    // Two, so that a second face in frame is seen and refused rather than
    // silently ignored.
    detector: { enabled: true, rotation: true, maxDetected: 2, skipFrames: 0, skipTime: 0, minConfidence: 0.4, return: false },
    mesh: { enabled: true },
    iris: { enabled: false },
    attention: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },
    liveness: { enabled: true, skipFrames: 0, skipTime: 0 },
    gear: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  segmentation: { enabled: false },
  gesture: { enabled: true },
} as Partial<Config>

let human: Human | null = null
let loading: Promise<Human> | null = null

/**
 * Whether the page can get a WebGL context. Chrome turns the GPU off for the
 * rest of its session after the GPU process crashes a few times, and the webgl
 * backend then fails on the first frame — so the face check would be dead
 * exactly when the rest of the HUD has already fallen back to its flat look.
 */
function webglWorks(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return Boolean(gl)
  } catch {
    return false
  }
}

/** Load the models once, on first use, and keep them for the session. */
export async function loadFaceReader(): Promise<FaceReader> {
  if (!human) {
    loading ??= (async () => {
      const { Human } = await import('@vladmandic/human')
      // No GPU: the CPU backend is several times slower per frame, but a slow
      // scan beats one that cannot start.
      const backend = webglWorks() ? 'webgl' : 'cpu'
      if (backend === 'cpu') console.warn('[jarvis] no WebGL — face models running on the CPU')
      const h = new Human({ ...CONFIG, backend })
      await h.load()
      human = h
      return h
    })().catch((err) => {
      loading = null
      throw new Error(
        `The face models could not be loaded (${(err as Error)?.message ?? err}). ` +
          'Restart JARVIS with npm start so they are copied into place.',
      )
    })
    await loading
  }
  return read
}

async function read(video: HTMLVideoElement): Promise<FaceReading> {
  const h = human
  if (!h) throw new Error('the face models are not loaded')
  const res = await h.detect(video)
  const faces = res.face ?? []
  const f = faces[0]
  if (!f) {
    return { faces: 0, box: null, size: 0, confidence: 0, real: 0, live: 0, facing: null, eyesClosed: false, embedding: null }
  }
  const gestures = (res.gesture ?? [])
    .filter((g) => 'face' in g && g.face === 0)
    .map((g) => g.gesture as string)
  const facing = gestures.includes('facing center')
    ? 'center'
    : gestures.includes('facing left')
      ? 'left'
      : gestures.includes('facing right')
        ? 'right'
        : null
  return {
    faces: faces.length,
    box: f.boxRaw ? [f.boxRaw[0], f.boxRaw[1], f.boxRaw[2], f.boxRaw[3]] : null,
    size: Math.min(f.box[2], f.box[3]),
    confidence: f.faceScore || f.boxScore || 0,
    real: f.real ?? 0,
    live: f.live ?? 0,
    facing,
    eyesClosed: gestures.includes('blink left eye') || gestures.includes('blink right eye'),
    embedding: f.embedding?.length ? Array.from(f.embedding) : null,
  }
}
