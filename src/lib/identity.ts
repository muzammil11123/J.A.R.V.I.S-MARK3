import { BACKEND, BRIDGE_HTTP_URL } from '../config'

/**
 * The page's half of face identity: talking to the bridge, which holds the
 * template and gives the verdict. See bridge/identity.mjs for why the split
 * runs that way round.
 *
 * Only embeddings cross this line. The camera frames that produced them stay
 * in face.ts and are dropped there.
 */

export type IdentityStatus = {
  face: { enrolled: boolean; at?: string; samples?: number; name?: string | null; photos?: number }
  profile?: Profile
  pin: boolean
  threshold: number
  locked_for_ms: number
  session: { method: 'face' | 'pin'; at: string } | null
  encrypted_at_rest: boolean
}

export type Verdict = {
  verified: boolean
  score?: number
  threshold?: number
  locked_for_ms?: number
  error?: string
  /** The profile, on a face match only. */
  name?: string | null
  personality?: string
}

export type Profile = { name: string | null; personality: string; updatedAt: string | null }

/** The template lives only in the bridge's encrypted store; direct mode has none. */
export const identityAvailable = BACKEND === 'bridge'

async function call<T>(path: string, body?: object): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as T
  return { ok: res.ok, status: res.status, data }
}

const fail = (data: unknown, fallback: string) => new Error((data as { error?: string })?.error ?? fallback)

export async function identityStatus(): Promise<IdentityStatus> {
  const r = await call<IdentityStatus>('/identity')
  if (!r.ok) throw fail(r.data, `The bridge refused (${r.status}).`)
  return r.data
}

/**
 * Store the face template, replacing any earlier one. `pin` is the existing
 * PIN; `newPin` sets one, and is only accepted while none exists — the first
 * enrolment is where it is chosen.
 */
export async function enrollFace(
  samples: number[][],
  auth: { pin?: string; newPin?: string },
  who: { name: string; photos: string[] },
) {
  const r = await call<{ enrolled?: boolean }>('/identity/enroll', { samples, ...auth, ...who })
  if (!r.ok) throw fail(r.data, `Enrolment failed (${r.status}).`)
  return r.data
}

/** A 429 or a no-match comes back as a Verdict, not a throw: both are answers. */
export async function verifyFace(embedding: number[]): Promise<Verdict> {
  const r = await call<Verdict>('/identity/verify', { embedding })
  if (!r.ok && r.status !== 429 && r.status !== 404) throw fail(r.data, `Verification failed (${r.status}).`)
  return r.data
}

export async function verifyPin(pin: string): Promise<Verdict> {
  const r = await call<Verdict>('/identity/pin/verify', { pin })
  if (!r.ok && r.status !== 429 && r.status !== 404) throw fail(r.data, `Verification failed (${r.status}).`)
  return r.data
}

export async function changePin(pin: string, newPin: string) {
  const r = await call('/identity/pin', { pin, newPin })
  if (!r.ok) throw fail(r.data, `Could not change the PIN (${r.status}).`)
}

/** Save the name and/or personality note. The bridge requires the PIN. */
export async function updateProfile(pin: string, patch: { name?: string; personality?: string }): Promise<Profile> {
  const r = await call<{ profile: Profile }>('/identity/profile', { pin, ...patch })
  if (!r.ok) throw fail(r.data, `Could not save the profile (${r.status}).`)
  return r.data.profile
}

export async function forget(what: 'face' | 'all', pin: string) {
  const r = await call('/identity/forget', { what, pin })
  if (!r.ok) throw fail(r.data, `Could not forget (${r.status}).`)
}
