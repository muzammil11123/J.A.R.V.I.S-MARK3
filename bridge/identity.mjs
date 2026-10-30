/**
 * Identity: whether the person in front of the PC is the one enrolled, by
 * face, or by PIN when the face check cannot be done.
 *
 * Face is the only biometric. JARVIS's microphone is for understanding
 * commands; it is never used to decide who is speaking.
 *
 * The browser does the looking — the models run there, on this machine — and
 * sends the bridge one thing: an embedding, a list of numbers that describes a
 * face and from which the face cannot be rebuilt. No photograph ever reaches
 * this file. The enrolled template is kept in the secret store, so on Windows
 * it is DPAPI-encrypted under your account and lives in ~/.jarvis/secrets,
 * which policy.mjs puts out of reach of every model tool.
 *
 * Matching happens HERE rather than in the page, and that is the point of the
 * split. A page that can read the template can be talked into leaking it, and
 * a page that decides "verified" for itself can simply be told to. So the
 * template goes in, never comes back out, and the verdict is the bridge's.
 *
 * Enrolling or forgetting a face needs the PIN. Without that the feature is
 * decoration: anyone at the keyboard could enrol their own face over yours and
 * then "verify" as you. The PIN is also the manual way in when the camera will
 * not cooperate.
 *
 * Repeated failures lock face and PIN together for a while. Separate counters
 * would let someone alternate between them and get twice the attempts.
 *
 * Nothing biometric is written to the audit log: an event, an outcome and a
 * similarity score, never an embedding.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { looksSecret } from './tools/memory.mjs'

/**
 * The face descriptor is Human's `faceres` model: 1024 numbers. Compared with
 * the library's own similarity measure and its published threshold, so the
 * number means what the model's author says it means rather than something
 * calibrated here on nobody's face. JARVIS_FACE_THRESHOLD moves it.
 */
const FACE = { dim: 1024, threshold: 0.5, match: { order: 2, multiplier: 25, min: 0.2, max: 0.8 } }

/** Enough samples to cover a turn of the head and a change of light, few
 *  enough that enrolment takes seconds rather than minutes. */
const MIN_SAMPLES = 3
const MAX_SAMPLES = 12

/** Failures in a row before everything locks, and for how long at first.
 *  The lock doubles each time it is hit again, up to the cap. */
const MAX_FAILURES = 5
const LOCK_MS = 60_000
const LOCK_CAP_MS = 15 * 60_000

const PIN_RULE = /^\d{4,12}$/

/**
 * What enrolment keeps besides the template: the name to greet you by, and a
 * few small face photos taken while you turned your head, so you can see what
 * was enrolled. The photos sit in the same encrypted secret as the template
 * and are never used for matching — that is still the embedding alone.
 */
const NAME_MAX = 40
const MAX_PHOTOS = 4
const PHOTO_MAX_CHARS = 120_000
const isPhoto = (p) => typeof p === 'string' && p.length <= PHOTO_MAX_CHARS && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p)
/** Drops control characters; `keepNewlines` keeps line breaks and tabs. */
const stripControls = (s, keepNewlines) =>
  [...String(s ?? '')].filter((c) => c.charCodeAt(0) >= 32 || (keepNewlines && (c === '\n' || c === '\t'))).join('')
const cleanName = (n) => stripControls(n, false).trim().slice(0, NAME_MAX)

/**
 * The personal profile: the name, and a personality note the person writes
 * themselves — how they like to be spoken to, what they care about. Kept in
 * its own secret so it survives re-enrolling or deleting the face, and handed
 * to JARVIS only after a face match, so nobody else at the keyboard gets
 * greeted as you or learns what you wrote. Nothing is filled in on your behalf.
 */
const PERSONALITY_MAX = 600
const cleanText = (t) => stripControls(t, true).trim().slice(0, PERSONALITY_MAX)

/* ------------------------------------------------------------------ maths */

/** Human's `similarity`, ported as-is from src/face/match.ts. */
export function faceSimilarity(a, b, { order, multiplier, min, max } = FACE.match) {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += order === 2 ? d * d : Math.abs(d) ** order
  }
  const dist = Math.round(100 * multiplier * sum) / 100
  if (dist === 0) return 1
  const root = order === 2 ? Math.sqrt(dist) : dist ** (1 / order)
  const norm = (1 - root / 100 - min) / (max - min)
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100
}

const isVector = (v) => Array.isArray(v) && v.length === FACE.dim && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/* ------------------------------------------------------------------ store */

const threshold = (env) => {
  const n = Number(env.JARVIS_FACE_THRESHOLD)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : FACE.threshold
}

/**
 * @param {{ secrets: ReturnType<typeof import('./tools/secrets.mjs').secretStore>,
 *           audit?: (e: object) => void, env?: Record<string, string|undefined>, now?: () => number }} opts
 */
export function identityStore({ secrets, audit = () => {}, env = process.env, now = Date.now }) {
  const minScore = threshold(env)

  let failures = 0
  let locks = 0
  let lockedUntil = 0
  /** The last successful verification, for anything that later wants to ask. */
  let session = null

  const lockedFor = () => Math.max(0, lockedUntil - now())
  const locked = () => ({ status: 429, body: { verified: false, locked_for_ms: lockedFor(), error: 'Too many failed attempts. Try again shortly.' } })

  const fail = () => {
    failures++
    if (failures >= MAX_FAILURES) {
      locks++
      lockedUntil = now() + Math.min(LOCK_CAP_MS, LOCK_MS * 2 ** (locks - 1))
      failures = 0
    }
  }
  const succeed = (method) => {
    failures = 0
    locks = 0
    session = { method, at: new Date(now()).toISOString() }
  }

  const hashPin = (pin, salt) => scryptSync(pin, Buffer.from(salt, 'base64'), 32).toString('base64')

  async function pinMatches(pin) {
    const stored = await secrets.get('identity-pin')
    if (!stored || typeof pin !== 'string') return false
    const a = Buffer.from(hashPin(pin, stored.salt), 'base64')
    const b = Buffer.from(stored.hash, 'base64')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async function setPin(pin) {
    const salt = randomBytes(16).toString('base64')
    await secrets.set('identity-pin', { salt, hash: hashPin(pin, salt), setAt: new Date(now()).toISOString() })
  }

  /**
   * The gate in front of enrolling and forgetting. A failed PIN here counts
   * towards the lockout like any other, or this would be the unlimited-guess
   * door around it.
   */
  async function authorise({ pin, newPin }) {
    if (lockedFor()) return { ok: false, ...locked() }
    if (!secrets.has('identity-pin')) {
      if (!PIN_RULE.test(String(newPin ?? ''))) return { ok: false, status: 400, body: { error: 'Choose a PIN of 4 to 12 digits first.' } }
      await setPin(String(newPin))
      return { ok: true }
    }
    if (await pinMatches(pin)) return { ok: true }
    fail()
    return { ok: false, status: 403, body: { error: 'That PIN is not correct.' } }
  }

  /** The profile, with a name kept on an older template as the fallback. */
  async function readProfile(template) {
    const p = secrets.has('identity-profile') ? await secrets.get('identity-profile').catch(() => null) : null
    return { name: p?.name ?? template?.name ?? null, personality: p?.personality ?? '', updatedAt: p?.updatedAt ?? null }
  }

  async function writeProfile(patch) {
    const current = secrets.has('identity-profile') ? await secrets.get('identity-profile').catch(() => null) : null
    await secrets.set('identity-profile', { name: null, personality: '', ...current, ...patch, updatedAt: new Date(now()).toISOString() })
  }

  async function status() {
    const t = secrets.has('identity-face') ? await secrets.get('identity-face').catch(() => null) : null
    const profile = await readProfile(t)
    return {
      face: t
        ? { enrolled: true, at: t.enrolledAt, samples: t.samples.length, name: profile.name, photos: t.photos?.length ?? 0 }
        : { enrolled: false },
      profile,
      pin: secrets.has('identity-pin'),
      threshold: minScore,
      locked_for_ms: lockedFor(),
      session,
      encrypted_at_rest: secrets.encrypted,
    }
  }

  /** Enrolling again replaces the old template outright; there is one face. */
  async function enroll({ samples, pin, newPin, name, photos }) {
    if (!Array.isArray(samples) || samples.length < MIN_SAMPLES || samples.length > MAX_SAMPLES || !samples.every(isVector)) {
      return { status: 400, body: { error: `expected ${MIN_SAMPLES}-${MAX_SAMPLES} face embeddings of ${FACE.dim} numbers` } }
    }
    const who = cleanName(name)
    if (!who) return { status: 400, body: { error: 'Tell me your name so I know who this face is.' } }
    const pics = photos == null ? [] : photos
    if (!Array.isArray(pics) || pics.length > MAX_PHOTOS || !pics.every(isPhoto)) {
      return { status: 400, body: { error: `expected up to ${MAX_PHOTOS} small JPEG face photos` } }
    }
    const gate = await authorise({ pin, newPin })
    if (!gate.ok) return gate
    await secrets.set('identity-face', {
      model: 'human-faceres',
      samples,
      photos: pics,
      enrolledAt: new Date(now()).toISOString(),
    })
    // The name goes into the profile, keeping any personality already written.
    await writeProfile({ name: who })
    audit({ event: 'identity', action: 'enroll', samples: samples.length, photos: pics.length })
    return { status: 200, body: { enrolled: true, name: who, samples: samples.length, photos: pics.length } }
  }

  /**
   * The verdict. The score is returned on a failure as well as a success: a
   * user whose genuine attempts keep landing at 0.48 against 0.5 needs to see
   * that to know it is the threshold, not the camera.
   */
  async function verify({ embedding }) {
    if (!isVector(embedding)) return { status: 400, body: { error: `expected one face embedding of ${FACE.dim} numbers` } }
    if (lockedFor()) return locked()
    const template = await secrets.get('identity-face').catch(() => null)
    if (!template) return { status: 404, body: { verified: false, error: 'No face is enrolled yet.' } }

    const score = Math.max(...template.samples.map((s) => faceSimilarity(embedding, s)))
    const verified = score >= minScore
    if (verified) succeed('face')
    else fail()
    audit({ event: 'identity', action: 'verify', method: 'face', ok: verified, score })
    // Name and personality only on a face match: this is the one answer that
    // lets JARVIS greet someone as you.
    const who = verified ? await readProfile(template) : null
    return {
      status: 200,
      body: {
        verified,
        score,
        threshold: minScore,
        locked_for_ms: lockedFor(),
        ...(who ? { name: who.name, personality: who.personality } : {}),
      },
    }
  }

  /** A PIN proves who is at the keyboard but never earns a greeting by name. */
  async function verifyPin({ pin }) {
    if (lockedFor()) return locked()
    if (!secrets.has('identity-pin')) return { status: 404, body: { verified: false, error: 'No PIN is set yet.' } }
    const verified = await pinMatches(pin)
    if (verified) succeed('pin')
    else fail()
    audit({ event: 'identity', action: 'verify', method: 'pin', ok: verified })
    return { status: 200, body: { verified, locked_for_ms: lockedFor() } }
  }

  /**
   * Change the PIN, which needs the current one — or, while none exists yet,
   * set the first one. That second case is no new door: the first enrolment
   * could always choose a PIN with nothing to check it against.
   */
  async function changePin({ pin, newPin }) {
    if (!PIN_RULE.test(String(newPin ?? ''))) return { status: 400, body: { error: 'The new PIN must be 4 to 12 digits.' } }
    if (!secrets.has('identity-pin')) {
      const gate = await authorise({ newPin })
      if (!gate.ok) return gate
      audit({ event: 'identity', action: 'pin_set' })
      return { status: 200, body: { changed: true, first: true } }
    }
    const gate = await authorise({ pin })
    if (!gate.ok) return gate
    await setPin(String(newPin))
    audit({ event: 'identity', action: 'pin_change' })
    return { status: 200, body: { changed: true } }
  }

  /** Edit the name and personality note. Needs the PIN, like any other change to who you are. */
  async function updateProfile({ pin, name, personality }) {
    if (!secrets.has('identity-pin')) return { status: 404, body: { error: 'Set a PIN first.' } }
    const patch = {}
    if (name !== undefined) {
      const who = cleanName(name)
      if (!who) return { status: 400, body: { error: 'The name cannot be empty.' } }
      patch.name = who
    }
    if (personality !== undefined) {
      const text = cleanText(personality)
      const why = looksSecret(text)
      if (why) return { status: 400, body: { error: `Not saved: it contains ${why}. Keep passwords and PINs out of your profile.` } }
      patch.personality = text
    }
    const gate = await authorise({ pin })
    if (!gate.ok) return gate
    await writeProfile(patch)
    audit({ event: 'identity', action: 'profile_update', fields: Object.keys(patch) })
    return { status: 200, body: { profile: await readProfile(null) } }
  }

  /** `all` takes the PIN with it, which is the only way back to a clean slate. */
  async function forget({ what, pin }) {
    if (what !== 'face' && what !== 'all') return { status: 400, body: { error: 'what must be face or all' } }
    const gate = await authorise({ pin })
    if (!gate.ok) return gate
    await secrets.remove('identity-face')
    if (what === 'all') {
      await secrets.remove('identity-pin')
      await secrets.remove('identity-profile')
      session = null
    }
    audit({ event: 'identity', action: 'forget', what })
    return { status: 200, body: { forgotten: what } }
  }

  /**
   * Replace the PIN wherever it appears in a piece of text — for anything that
   * is about to be written down, like the task history. People say their PIN
   * out loud to an assistant, and the recogniser does not always hear the word
   * "PIN" next to it ("the penis 2006"), so a filter on wording alone misses
   * it. Each run of digits is checked against the stored hash instead; the PIN
   * itself is never known here.
   */
  async function redactPin(text) {
    const s = String(text ?? '')
    const stored = secrets.has('identity-pin') ? await secrets.get('identity-pin').catch(() => null) : null
    if (!stored) return s
    const runs = [...new Set(s.match(/\d(?:[ -]?\d){3,11}/g) ?? [])].slice(0, 20)
    let out = s
    for (const run of runs) {
      const digits = run.replace(/\D/g, '')
      if (PIN_RULE.test(digits) && (await pinMatches(digits))) out = out.split(run).join('[PIN]')
    }
    return out
  }

  return { status, enroll, verify, verifyPin, changePin, updateProfile, forget, redactPin, session: () => session }
}

/** The routes the console and the face popup use. All POST bodies are JSON. */
export const IDENTITY_ROUTES = ['/identity', '/identity/enroll', '/identity/verify', '/identity/pin/verify', '/identity/pin', '/identity/profile', '/identity/forget']

/** Twelve embeddings as JSON is ~250KB, plus up to four ~120KB face photos;
 *  the general 64KB cap is for everything else. */
export const IDENTITY_MAX_BODY = 1024 * 1024
