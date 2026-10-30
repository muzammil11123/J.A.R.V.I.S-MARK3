import { useSyncExternalStore } from 'react'

/**
 * The person's own choices about how JARVIS listens and speaks, kept in this
 * browser. Small on purpose: anything that matters for safety lives in the
 * bridge, where a page cannot change it.
 *
 * localStorage can be missing or throw (private windows, blocked storage), so
 * every access is guarded and the defaults always work.
 */

export type Settings = {
  /** deviceId of the chosen microphone; '' = the system default. */
  micId: string
  /** Listen for "Hey Jarvis" while dormant. Off means push-to-talk only. */
  handsFree: boolean
  /** Browser speech rate. 0.92 is the character's own pace. */
  rate: number
  /** Answer F with the face check. Off keeps the enrolled
   *  template but never opens the camera for it. */
  faceId: boolean
}

const KEY = 'jarvis.settings'
const DEFAULTS: Settings = { micId: '', handsFree: true, rate: 0.92, faceId: true }

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

let current = load()
const subs = new Set<() => void>()

export const getSettings = (): Settings => current

export function setSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* kept for this session only */
  }
  subs.forEach((f) => f())
  return current
}

export function onSettings(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettings, getSettings)
}
