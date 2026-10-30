import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { watchActivity, type PlanItem, type Step } from '../lib/bridge'
import { listMics, micStatus, onMicStatus, switchMic } from '../lib/audio'
import { setSettings, useSettings } from '../lib/settings'
import { candidateVoices, chooseVoice, currentVoiceName, speechOutputIsCloud } from '../lib/tts'
import { caps } from '../lib/capabilities'
import { changePin, forget, identityAvailable, identityStatus, updateProfile, type IdentityStatus, type Profile } from '../lib/identity'
import { openFaceId } from '../lib/faceId'

/**
 * The console: what JARVIS is doing, what it is connected to, and the
 * controls the person keeps for themselves.
 *
 * Press C. Everything shown comes from the bridge's /status and /memory or
 * from the activity frames its policy and result hooks send for every tool —
 * nothing is assumed. A connection is "connected" only when the bridge has
 * just checked it, and an unconfigured one says what it needs.
 *
 * Two pieces stay on screen with the console closed, because they matter
 * most when something is happening: the microphone readout (is it listening,
 * and is the audio leaving this machine) and the STOP button.
 */

// ---------------------------------------------------------------------------
// Activity, from the bridge
// ---------------------------------------------------------------------------

type ActivityState = {
  steps: Step[]
  plan: PlanItem[]
  add: (s: Step) => void
  setPlan: (p: PlanItem[]) => void
  clear: () => void
}

const useActivity = create<ActivityState>((set) => ({
  steps: [],
  plan: [],
  // A step is updated in place as it moves from approval to running to done,
  // so the timeline shows one line per call, not one per event.
  add: (s) =>
    set((st) => {
      const i = s.id ? st.steps.findIndex((x) => x.id === s.id) : -1
      if (i >= 0) {
        const steps = st.steps.slice()
        steps[i] = { ...steps[i], ...s, reason: s.reason ?? steps[i].reason, risk: s.risk ?? steps[i].risk }
        return { steps }
      }
      return { steps: [...st.steps, s].slice(-80) }
    }),
  setPlan: (plan) => set({ plan }),
  clear: () => set({ steps: [], plan: [] }),
}))

watchActivity(
  (s) => useActivity.getState().add(s),
  (p) => useActivity.getState().setPlan(p),
)

const pretty = (raw: string) => {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server.replace(/^jarvis_/, '')} · ${rest.join(' ').replace(/_/g, ' ')}`
}

const STATUS_LABEL: Record<Step['status'], string> = {
  running: 'running',
  'awaiting-approval': 'waiting for you',
  denied: 'refused',
  ok: 'done',
  error: 'failed',
  note: '',
}

// ---------------------------------------------------------------------------
// Bridge HTTP
// ---------------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim())
  return res.json() as Promise<T>
}

type Status = {
  model: string
  effort: string
  writes: boolean
  browser_control: boolean
  tools: number
  system: {
    cpu_percent: number | null
    memory_percent: number
    memory_used_gb: number
    memory_total_gb: number
    uptime_hours: number
    disks: { drive: string; free_gb: number; total_gb: number }[]
  }
  integrations: {
    google: { configured: boolean; connected: boolean; account?: string | null; error?: string }
    whatsapp: { personal_links: boolean; business_api: boolean }
    phone: { adb: boolean; error?: string; devices: { serial: string; state: string; model: string | null; paired: boolean; permissions: { location: boolean; notifications: boolean } }[] }
    phone_wifi: WifiStatus
    home: { configured: boolean; connected: boolean; url?: string; error?: string }
    memory: { persist: boolean; history: boolean; retentionDays: number; items: number; docs_folders: number }
    secrets: { encrypted_at_rest: boolean }
  }
}

type WifiDevice = {
  id: string
  name: string
  model: string | null
  connected: boolean
  paused: boolean
  last_connected: string | null
  last_seen: string | null
  address: string | null
  battery: { level: number | null; charging: boolean | null } | null
  permissions: Record<string, string> | null
  enabled: Record<string, boolean> | null
}
type WifiStatus = { listening: string[]; pairing: { active: boolean; expiresAt: string } | null; devices: WifiDevice[] }
type Pairing = { active: boolean; expiresAt?: string; qrSvg?: string; uri?: string }

type MemoryView = {
  settings: { persist: boolean; history: boolean; retentionDays: number }
  items: { id: string; kind: string; text: string; createdAt: string }[]
  history: { at: string; question: string; tools?: string[]; ok: boolean }[]
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return <span className={`con-dot ${on ? 'on' : warn ? 'warn' : 'off'}`} aria-hidden="true" />
}

function Line({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="con-line">
      <span className="con-k">{k}</span>
      <span className="con-v">{children}</span>
    </div>
  )
}

/** Where speech goes, stated rather than implied. */
function speechRoute() {
  return {
    stt: caps().stt ? 'ElevenLabs (cloud)' : 'Chrome speech service (Google cloud)',
    tts: speechOutputIsCloud() ? 'ElevenLabs (cloud)' : 'this PC (system voice)',
  }
}

/** Always on screen: the mic, and where its audio goes while it is open. */
export function MicReadout() {
  const phase = useStore((s) => s.phase)
  const mic = useSyncExternalStore(onMicStatus, micStatus)
  const { handsFree } = useSettings()
  if (phase === 'offline' || phase === 'boot') return null

  let label: string
  let tone: 'on' | 'warn' | 'off' = 'off'
  if (mic.status === 'denied') {
    label = 'MIC BLOCKED — allow it in the browser'
    tone = 'warn'
  } else if (mic.status === 'lost' || mic.status === 'missing') {
    label = 'MIC DISCONNECTED — plug it back in or pick another (C)'
    tone = 'warn'
  } else if (phase === 'listening' || phase === 'waking') {
    label = `LISTENING · audio → ${speechRoute().stt}`
    tone = 'on'
  } else if (phase === 'thinking' || phase === 'tooling') {
    label = 'PROCESSING'
    tone = 'on'
  } else if (phase === 'speaking') {
    label = 'SPEAKING · talk to interrupt'
    tone = 'on'
  } else {
    label = handsFree ? `WAKE WORD ON · audio → ${speechRoute().stt}` : 'MIC IDLE · press Space to talk'
  }
  return (
    <div className={`mic-readout ${tone}`} role="status" aria-live="polite">
      <Dot on={tone === 'on'} warn={tone === 'warn'} /> {label}
    </div>
  )
}

/** Always on screen while anything is in flight. */
export function StopButton() {
  const phase = useStore((s) => s.phase)
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const running = useActivity((s) => s.steps.some((x) => x.status === 'running' || x.status === 'awaiting-approval'))
  if (!busy && !running) return null
  return (
    <button
      type="button"
      className="stop-button"
      onClick={() => window.dispatchEvent(new CustomEvent('jarvis:stop'))}
      title="Stop speaking, cancel the task and any running tool (Esc)"
    >
      ■ STOP <kbd>Esc</kbd>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function StatusTab({ status, error }: { status: Status | null; error: string | null }) {
  const voice = useStore((s) => s.voice)
  const mic = useSyncExternalStore(onMicStatus, micStatus)
  const route = speechRoute()
  if (error) return <p className="con-empty con-bad">Bridge not reachable: {error}</p>
  if (!status) return <p className="con-empty">Checking…</p>
  const s = status.system
  return (
    <>
      <div className="con-sec">BRAIN</div>
      <Line k="model">{status.model} · effort {status.effort}</Line>
      <Line k="actions"><Dot on={status.writes} warn={!status.writes} /> {status.writes ? 'enabled (approval for risky ones)' : 'read-only mode'}</Line>
      <Line k="tools">{status.tools} JARVIS tools · browser control {status.browser_control ? 'ready' : 'unavailable'}</Line>
      <div className="con-sec">THIS PC</div>
      <Line k="cpu">{s.cpu_percent ?? '—'}%</Line>
      <Line k="memory">{s.memory_used_gb} / {s.memory_total_gb} GB ({s.memory_percent}%)</Line>
      {s.disks.map((d) => (
        <Line key={d.drive} k={`disk ${d.drive}`}>{d.free_gb} GB free of {d.total_gb} GB</Line>
      ))}
      <Line k="uptime">{s.uptime_hours} h</Line>
      <div className="con-sec">VOICE</div>
      <Line k="microphone"><Dot on={mic.status === 'live'} warn={mic.status !== 'live' && mic.status !== 'idle'} /> {mic.status}{mic.label ? ` · ${mic.label}` : ''}</Line>
      <Line k="permission">{mic.permission}</Line>
      <Line k="speech in">{route.stt}</Line>
      <Line k="speech out">{route.tts} · {voice || currentVoiceName()}</Line>
    </>
  )
}

function ActivityTab() {
  const { steps, plan, clear } = useActivity()
  return (
    <>
      {plan.length > 0 && (
        <>
          <div className="con-sec">PLAN</div>
          <ol className="con-plan">
            {plan.map((p, i) => (
              <li key={i} className={`plan-${p.status}`}>{p.text}</li>
            ))}
          </ol>
        </>
      )}
      <div className="con-sec">
        TOOL CALLS
        {steps.length > 0 && <button type="button" className="con-link" onClick={clear}>clear</button>}
      </div>
      {steps.length === 0 && <p className="con-empty">Nothing yet. Every tool call appears here with its decision and result.</p>}
      <ul className="con-steps">
        {[...steps].reverse().map((s, i) => (
          <li key={s.id ?? `n${i}`} className={`step step-${s.status}`}>
            <span className="step-time">{new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="step-tool">{pretty(s.tool)}</span>
            <span className="step-status">{s.status === 'note' ? s.note : STATUS_LABEL[s.status]}</span>
            {s.reason && s.status !== 'running' && s.status !== 'ok' && <span className="step-reason">{s.reason}</span>}
          </li>
        ))}
      </ul>
    </>
  )
}

function VoiceTab() {
  const settings = useSettings()
  const mic = useSyncExternalStore(onMicStatus, micStatus)
  const [mics, setMics] = useState<{ id: string; label: string }[]>([])
  const [voices, setVoices] = useState<string[]>([])
  const [current, setCurrent] = useState(currentVoiceName())
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void listMics().then(setMics).catch((e) => setErr(String(e?.message ?? e)))
    setVoices(candidateVoices().map((v) => v.name))
  }, [])
  useEffect(() => {
    refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
  }, [refresh])

  return (
    <>
      <div className="con-sec">MICROPHONE</div>
      <label className="con-field">
        <span>input</span>
        <select
          value={settings.micId}
          onChange={(e) => {
            setSettings({ micId: e.target.value })
            setErr(null)
            void switchMic().catch((x) => setErr(`Could not open that microphone: ${x?.message ?? x}`))
          }}
        >
          <option value="">System default</option>
          {mics.filter((m) => m.id).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button type="button" className="con-link" onClick={refresh}>refresh</button>
      </label>
      <p className="con-note">
        Now: {mic.status}{mic.label ? ` · ${mic.label}` : ''}. {caps().stt ? '' : 'Chrome’s speech recogniser always uses the system default microphone; the choice here drives the level meter and the ElevenLabs path.'}
      </p>
      {err && <p className="con-note con-bad">{err}</p>}

      <div className="con-sec">LISTENING</div>
      <label className="con-check">
        <input type="checkbox" checked={settings.handsFree} onChange={(e) => setSettings({ handsFree: e.target.checked })} />
        Hands-free: listen for “Hey Jarvis” while idle
      </label>
      <p className="con-note">Off means push-to-talk only: press Space to speak. Escape always stops speech and cancels the task.</p>

      <div className="con-sec">SPEAKING</div>
      <label className="con-field">
        <span>voice</span>
        <select
          value={current}
          onChange={(e) => {
            if (chooseVoice(e.target.value)) {
              setCurrent(e.target.value)
              useStore.getState().setVoice(e.target.value)
            }
          }}
          disabled={speechOutputIsCloud() || !voices.length}
        >
          {!voices.includes(current) && <option value={current}>{current}</option>}
          {voices.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="con-field">
        <span>rate</span>
        <input type="range" min={0.6} max={1.4} step={0.02} value={settings.rate} onChange={(e) => setSettings({ rate: Number(e.target.value) })} />
        <span className="con-mono">{settings.rate.toFixed(2)}×</span>
      </label>
      <p className="con-note">V cycles voices. T plays a test line. D opens audio diagnostics.</p>
    </>
  )
}

function MemoryTab() {
  const [data, setData] = useState<MemoryView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    api<MemoryView>('/memory').then(setData, (e) => setErr(String(e.message)))
  }, [])
  useEffect(load, [load])

  const settings = async (patch: Partial<MemoryView['settings']>) => {
    await api('/memory/settings', { method: 'PUT', body: JSON.stringify(patch) }).catch((e) => setErr(String(e.message)))
    load()
  }

  if (err) return <p className="con-empty con-bad">{err}</p>
  if (!data) return <p className="con-empty">Loading…</p>
  return (
    <>
      <div className="con-sec">SETTINGS</div>
      <label className="con-check">
        <input type="checkbox" checked={data.settings.persist} onChange={(e) => void settings({ persist: e.target.checked })} />
        Persistent memory (off: nothing new is saved)
      </label>
      <label className="con-check">
        <input type="checkbox" checked={data.settings.history} disabled={!data.settings.persist} onChange={(e) => void settings({ history: e.target.checked })} />
        Keep a searchable history of requests
      </label>
      <label className="con-field">
        <span>keep for</span>
        <input type="number" min={1} max={3650} defaultValue={data.settings.retentionDays} onBlur={(e) => void settings({ retentionDays: Number(e.target.value) })} />
        <span>days</span>
      </label>
      <p className="con-note">Passwords, PINs, keys and tokens are refused and never stored.</p>

      <div className="con-sec">
        REMEMBERED ({data.items.length})
        <a className="con-link" href={`${BRIDGE_HTTP_URL}/memory/export`} onClick={(e) => {
          // Fetched rather than followed, so the request carries this page's origin.
          e.preventDefault()
          void fetch(`${BRIDGE_HTTP_URL}/memory/export`).then((r) => r.blob()).then((b) => {
            const a = document.createElement('a')
            a.href = URL.createObjectURL(b)
            a.download = 'jarvis-memory.json'
            a.click()
            URL.revokeObjectURL(a.href)
          })
        }}>export</a>
        <button type="button" className="con-link con-bad" onClick={() => {
          if (window.confirm('Delete every saved memory and the request history?')) void api('/memory', { method: 'DELETE' }).then(load)
        }}>delete all</button>
      </div>
      {data.items.length === 0 && <p className="con-empty">Nothing saved. Say “remember that…” to add something.</p>}
      <ul className="con-mem">
        {data.items.map((m) => (
          <li key={m.id}>
            <span className="con-tag">{m.kind}</span> {m.text}
            <button type="button" className="con-link con-bad" aria-label={`Forget ${m.text}`} onClick={() => void api(`/memory/item?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' }).then(load)}>forget</button>
          </li>
        ))}
      </ul>

      <div className="con-sec">RECENT REQUESTS</div>
      {data.history.length === 0 && <p className="con-empty">{data.settings.history ? 'None yet.' : 'History is off.'}</p>}
      <ul className="con-hist">
        {data.history.map((h, i) => (
          <li key={i} className={h.ok ? '' : 'con-bad'}>
            <span className="step-time">{new Date(h.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span> {h.question}
            {h.tools?.length ? <span className="con-dim"> · {h.tools.map(pretty).join(', ')}</span> : null}
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Face recognition: on or off, enrol, re-enrol, delete, and the PIN. Every
 * change that touches the stored face asks for the PIN, enforced by the bridge.
 */
function IdentityTab() {
  const settings = useSettings()
  const face = useStore((s) => s.faceId)
  const verified = useStore((s) => s.identity)
  const [data, setData] = useState<IdentityStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback(() => {
    identityStatus().then(setData, (e) => setErr(String(e.message)))
  }, [])
  // Reloaded when the popup closes, so a fresh enrolment shows at once.
  useEffect(load, [load, face == null])

  const withPin = async (what: string, act: (pin: string) => Promise<unknown>) => {
    const pin = window.prompt(`Enter your PIN to ${what}.`)
    if (!pin) return
    setErr(null)
    try {
      await act(pin)
      setNote(`Done: ${what}.`)
    } catch (e) {
      setErr(String((e as Error).message))
    }
    load()
  }

  if (!identityAvailable) return <p className="con-empty">Face recognition needs the bridge, which keeps the template encrypted. Run JARVIS with npm start.</p>
  return (
    <>
      <div className="con-sec">FACE RECOGNITION</div>
      <label className="con-check">
        <input type="checkbox" checked={settings.faceId} onChange={(e) => setSettings({ faceId: e.target.checked })} />
        Enabled: F opens the face check
      </label>
      <p className="con-note">Off never opens the camera for a face check. The enrolment is kept until you delete it.</p>
      {err && <p className="con-note con-bad">{err}</p>}
      {note && !err && <p className="con-note">{note}</p>}
      {!data && !err && <p className="con-empty">Checking…</p>}
      {data && (
        <>
          <Line k="face">
            <Dot on={data.face.enrolled} /> {data.face.enrolled ? `enrolled ${new Date(data.face.at ?? '').toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${data.face.samples} samples` : 'not enrolled'}
          </Line>
          <Line k="PIN">{data.pin ? 'set (stored as a salted scrypt hash)' : 'not set'}</Line>
          <Line k="stored">
            template{data.face.photos ? ` + ${data.face.photos} face picture${data.face.photos === 1 ? '' : 's'}` : ''} + profile,{' '}
            {data.encrypted_at_rest ? 'encrypted with Windows DPAPI' : 'owner-only file'}
          </Line>
          <Line k="match at">similarity ≥ {data.threshold} (JARVIS_FACE_THRESHOLD)</Line>
          <Line k="this session">{verified ? `verified by ${verified.method} at ${new Date(verified.at).toLocaleTimeString()}` : 'not verified'}</Line>
          {data.locked_for_ms > 0 && <p className="con-note con-bad">Locked after repeated failures for another {Math.ceil(data.locked_for_ms / 1000)} s.</p>}
          <div className="con-row">
            <button type="button" className="con-btn" disabled={!settings.faceId} onClick={() => openFaceId('enroll')}>
              {data.face.enrolled ? 'Re-enrol face' : 'Enrol face'}
            </button>
            {data.face.enrolled && (
              <button type="button" className="con-btn" disabled={!settings.faceId} onClick={() => openFaceId('verify')}>
                Verify now
              </button>
            )}
          </div>
          {data.pin && (
            <div className="con-row">
              {data.face.enrolled && (
                <button type="button" className="con-link con-bad" onClick={() => void withPin('delete your face profile', (pin) => forget('face', pin))}>
                  delete face profile
                </button>
              )}
              <button
                type="button"
                className="con-link"
                onClick={() => {
                  const next = window.prompt('New PIN (4–12 digits)')
                  if (next) void withPin('change the PIN', (pin) => changePin(pin, next))
                }}
              >
                change PIN
              </button>
              <button type="button" className="con-link con-bad" onClick={() => void withPin('delete the face profile and the PIN', (pin) => forget('all', pin))}>
                reset everything
              </button>
            </div>
          )}
          {!data.pin && (
            <div className="con-row">
              <button
                type="button"
                className="con-link"
                onClick={() => {
                  const next = window.prompt('Choose a PIN (4–12 digits)')
                  if (!next) return
                  setErr(null)
                  changePin('', next).then(() => setNote('Done: PIN set.'), (e) => setErr(String((e as Error).message))).finally(load)
                }}
              >
                set PIN
              </button>
            </div>
          )}
          <p className="con-note">
            Liveness: an anti-spoof model, a liveness model and a blink are all required. They stop photos and most screens; they are not certified anti-spoofing.
          </p>
          <ProfileEditor profile={data.profile} pinSet={data.pin} withPin={withPin} />
        </>
      )}
    </>
  )
}

/**
 * Your name and personality note. Nothing is filled in for you: the saved
 * memories are listed so you can copy across what you choose, and saving needs
 * the PIN. JARVIS only reads this after your face has matched.
 */
function ProfileEditor({
  profile,
  pinSet,
  withPin,
}: {
  profile: Profile | undefined
  pinSet: boolean
  withPin: (what: string, act: (pin: string) => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [personality, setPersonality] = useState(profile?.personality ?? '')
  const [memories, setMemories] = useState<MemoryView['items']>([])
  useEffect(() => {
    setName(profile?.name ?? '')
    setPersonality(profile?.personality ?? '')
  }, [profile?.name, profile?.personality])
  useEffect(() => {
    api<MemoryView>('/memory').then((m) => setMemories(m.items), () => setMemories([]))
  }, [])
  const changed = name.trim() !== (profile?.name ?? '') || personality.trim() !== (profile?.personality ?? '')

  return (
    <>
      <div className="con-sec">YOUR PROFILE</div>
      <p className="con-note">Used only after your face is recognised: JARVIS greets you by this name and reads your note. Saving needs your PIN.</p>
      <label className="con-field con-stack">
        <span>name</span>
        <input type="text" maxLength={40} value={name} placeholder="not set" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="con-field con-stack">
        <span>personality</span>
        <textarea
          rows={4}
          maxLength={600}
          value={personality}
          placeholder="How you like JARVIS to talk to you, what you care about — in your own words."
          onChange={(e) => setPersonality(e.target.value)}
        />
      </label>
      {memories.length > 0 && (
        <>
          <p className="con-note">From your saved memory — add any you want in your profile:</p>
          <ul className="con-mem">
            {memories.map((m) => (
              <li key={m.id}>
                {m.text}
                <button
                  type="button"
                  className="con-link"
                  disabled={personality.includes(m.text)}
                  onClick={() => setPersonality((p) => (p.trim() ? `${p.trim()}\n${m.text}` : m.text).slice(0, 600))}
                >
                  add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="con-row">
        <button
          type="button"
          className="con-btn"
          disabled={!pinSet || !changed || !name.trim()}
          title={!pinSet ? 'Set a PIN first' : undefined}
          onClick={() => void withPin('save your profile', (pin) => updateProfile(pin, { name, personality }))}
        >
          Save profile
        </button>
      </div>
    </>
  )
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'never')

/**
 * The phone over Wi-Fi. Green only for an authenticated session that exists
 * right now; a paired phone that is not connected says so, with when it was
 * last seen.
 */
function WifiPhone({ wifi, reload }: { wifi: WifiStatus; reload: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // While a pairing is open, follow it: the QR code, the countdown, and the
  // moment it completes or expires.
  useEffect(() => {
    let alive = true
    const tick = () =>
      api<Pairing>('/phone/wifi/pairing').then(
        (p) => {
          if (!alive) return
          setPairing((was) => {
            if (was?.active && !p.active) reload()
            return p.active ? p : null
          })
          setNow(Date.now())
        },
        () => {},
      )
    void tick()
    const id = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [reload])

  const post = (path: string, body?: object) =>
    api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }).then(reload, (e) => setErr(String(e.message)))

  const left = pairing?.expiresAt ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000)) : 0

  return (
    <>
      <div className="con-sec">
        PHONE · WI-FI COMPANION
        {!pairing && (
          <button type="button" className="con-link" onClick={() => { setErr(null); void post('/phone/wifi/pair') }}>
            pair a phone
          </button>
        )}
      </div>
      <Line k="listening">{wifi.listening.length ? wifi.listening.join(', ') : 'off (starts when a phone is paired or pairing begins)'}</Line>

      {pairing?.qrSvg && (
        <div className="con-pair">
          <img className="con-qr" alt="Pairing QR code: scan it in the JARVIS companion app" src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`} />
          <ol className="con-steps-help">
            <li>Open the JARVIS companion app on the phone, tap <b>Pair with PC</b>, scan this code.</li>
            <li>Check the 6-digit code on the phone matches the one in the approval prompt here.</li>
            <li>Approve here, and tap <b>Confirm</b> on the phone.</li>
          </ol>
          <p className="con-note">
            Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. Both devices must be on the same Wi-Fi.
            <button type="button" className="con-link" onClick={() => void navigator.clipboard?.writeText(pairing.uri ?? '')}>copy link</button>
            <button type="button" className="con-link con-bad" onClick={() => void post('/phone/wifi/cancel').then(() => setPairing(null))}>cancel</button>
          </p>
        </div>
      )}
      {err && <p className="con-note con-bad">{err}</p>}

      {wifi.devices.length === 0 && !pairing && <p className="con-note">No phone paired over Wi-Fi. Install the companion app (README → Wi-Fi companion), then pair.</p>}
      {wifi.devices.map((d) => {
        const perms = d.permissions ?? {}
        return (
          <div key={d.id} className="con-device">
            <Line k={d.name}>
              <Dot on={d.connected} warn={!d.connected} />{' '}
              {d.connected ? `connected · ${d.address ?? ''}` : d.paused ? 'disconnected by you' : `not connected · last seen ${when(d.last_seen ?? d.last_connected)}`}
            </Line>
            {d.connected && d.battery?.level != null && <Line k="battery">{d.battery.level}%{d.battery.charging ? ' · charging' : ''}</Line>}
            {d.connected && (
              <Line k="on the phone">
                {['contacts', 'calls', 'location', 'notifications', 'whatsapp', 'sms', 'sms_history']
                  .map((c) => `${c} ${d.enabled?.[c] ? (perms[c] && perms[c] !== 'granted' ? `on (Android: ${perms[c]})` : 'on') : 'off'}`)
                  .join(' · ')}
              </Line>
            )}
            {!d.connected && <Line k="last connected">{when(d.last_connected)}</Line>}
            <div className="con-row">
              {d.paused ? (
                <button type="button" className="con-link" onClick={() => void post('/phone/wifi/reconnect', { deviceId: d.id })}>reconnect</button>
              ) : (
                <button type="button" className="con-link" onClick={() => void post('/phone/wifi/disconnect', { deviceId: d.id })}>disconnect</button>
              )}
              <button
                type="button"
                className="con-link con-bad"
                onClick={() => {
                  if (window.confirm(`Unpair ${d.name}? It will need pairing again.`)) void post('/phone/wifi/revoke', { deviceId: d.id })
                }}
              >
                revoke
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

function ConnectionsTab({ status, reload }: { status: Status | null; reload: () => void }) {
  if (!status) return <p className="con-empty">Checking…</p>
  const { google, whatsapp, phone, home, secrets } = status.integrations
  return (
    <>
      {status.integrations.phone_wifi && <WifiPhone wifi={status.integrations.phone_wifi} reload={reload} />}

      <div className="con-sec">GOOGLE · GMAIL & CALENDAR</div>
      <Line k="status">
        <Dot on={google.connected} warn={google.configured && !google.connected} />{' '}
        {google.connected ? `connected${google.account ? ` as ${google.account}` : ''}` : google.configured ? 'not connected' : 'not set up'}
      </Line>
      {!google.configured && <p className="con-note">Needs a Google Cloud “Desktop app” OAuth client: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart. See README → Google.</p>}
      {google.configured && !google.connected && (
        <button type="button" className="con-btn" onClick={() => window.open(`${BRIDGE_HTTP_URL}/oauth/google/start`, '_blank', 'noopener')}>Connect Google</button>
      )}
      {google.connected && (
        <button type="button" className="con-btn con-bad" onClick={() => void api('/oauth/google/disconnect', { method: 'POST' }).then(reload)}>Disconnect and revoke</button>
      )}

      <div className="con-sec">PHONE · USB (ADB)</div>
      <Line k="adb"><Dot on={phone.adb} warn={!phone.adb} /> {phone.adb ? 'available' : phone.error ?? 'not found'}</Line>
      {phone.adb && phone.devices.length === 0 && <p className="con-note">No phone connected. Turn on USB debugging and plug it in, or use wireless debugging.</p>}
      {phone.devices.map((d) => (
        <div key={d.serial} className="con-device">
          <Line k={d.model ?? d.serial}>
            <Dot on={d.state === 'device' && d.paired} warn={d.state !== 'device'} /> {d.state}{d.paired ? ' · paired' : ' · not paired (ask JARVIS to pair it)'}
          </Line>
          {d.paired && (
            <div className="con-row">
              location {d.permissions.location ? 'allowed' : 'off'} · notifications {d.permissions.notifications ? 'allowed' : 'off'}
              {d.permissions.location && <button type="button" className="con-link con-bad" onClick={() => void api('/phone/revoke', { method: 'POST', body: JSON.stringify({ serial: d.serial, capability: 'location' }) }).then(reload)}>revoke location</button>}
              {d.permissions.notifications && <button type="button" className="con-link con-bad" onClick={() => void api('/phone/revoke', { method: 'POST', body: JSON.stringify({ serial: d.serial, capability: 'notifications' }) }).then(reload)}>revoke notifications</button>}
              <button type="button" className="con-link con-bad" onClick={() => void api('/phone/revoke', { method: 'POST', body: JSON.stringify({ serial: d.serial }) }).then(reload)}>unpair</button>
            </div>
          )}
        </div>
      ))}

      <div className="con-sec">WHATSAPP</div>
      <Line k="personal"><Dot on={whatsapp.personal_links} /> prepares chats; you press send</Line>
      <Line k="business API"><Dot on={whatsapp.business_api} /> {whatsapp.business_api ? 'configured' : 'not set up (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)'}</Line>

      <div className="con-sec">HOME ASSISTANT</div>
      <Line k="status">
        <Dot on={home.connected} warn={home.configured && !home.connected} />{' '}
        {home.connected ? `connected · ${home.url}` : home.configured ? `unreachable${home.error ? ` · ${home.error}` : ''}` : 'not set up (HASS_URL, HASS_TOKEN)'}
      </Line>

      <div className="con-sec">SECRETS</div>
      <Line k="tokens">{secrets.encrypted_at_rest ? 'encrypted with Windows DPAPI' : 'owner-only file'} in ~/.jarvis/secrets</Line>
    </>
  )
}

// ---------------------------------------------------------------------------

const TABS = ['status', 'activity', 'voice', 'identity', 'memory', 'connections'] as const
type Tab = (typeof TABS)[number]

export function Console() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('status')
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useActivity((s) => s.steps.filter((x) => x.status === 'running' || x.status === 'awaiting-approval').length)

  const reload = useCallback(() => {
    api<Status>('/status').then(
      (s) => {
        setStatus(s)
        setError(null)
      },
      (e) => setError(String(e.message)),
    )
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'c' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    // Pairing started by voice: open on Connections so the QR code is visible.
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: Tab }>).detail?.tab
      if (tab && TABS.includes(tab)) setTab(tab)
      setOpen(true)
    }
    window.addEventListener('jarvis:open-console', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('jarvis:open-console', onOpen)
    }
  }, [])

  // Polled only while open, and not faster than the numbers change.
  useEffect(() => {
    if (!open) return
    reload()
    const id = setInterval(reload, 8000)
    return () => clearInterval(id)
  }, [open, reload])

  return (
    <>
      <MicReadout />
      <StopButton />
      <button type="button" className="console-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="jarvis-console">
        CONSOLE <kbd>C</kbd>{pending ? <span className="con-badge">{pending}</span> : null}
      </button>
      {open && (
        <aside id="jarvis-console" className="console" aria-label="JARVIS console">
          <div className="con-head">
            <span>CONSOLE</span>
            <button type="button" className="con-link" onClick={() => setOpen(false)} aria-label="Close console">close · C</button>
          </div>
          <div className="con-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="con-body" role="tabpanel">
            {tab === 'status' && <StatusTab status={status} error={error} />}
            {tab === 'activity' && <ActivityTab />}
            {tab === 'voice' && <VoiceTab />}
            {tab === 'identity' && <IdentityTab />}
            {tab === 'memory' && <MemoryTab />}
            {tab === 'connections' && <ConnectionsTab status={status} reload={reload} />}
          </div>
        </aside>
      )}
    </>
  )
}
