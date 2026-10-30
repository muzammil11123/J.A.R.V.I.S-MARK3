/**
 * The Wi-Fi link to the JARVIS companion app on the phone.
 *
 * The phone connects here; JARVIS never connects out to it. What makes the
 * link safe is not the network it runs on — being on the same Wi-Fi earns a
 * device nothing — but three things:
 *
 *   TLS with a pinned certificate. The desktop's self-signed certificate is
 *   generated once and its SHA-256 fingerprint travels inside the pairing QR
 *   code, so the phone talks only to this PC, never to whoever answers on the
 *   address.
 *
 *   Pairing that needs the QR code and two people's yes. The QR carries a
 *   32-byte one-time secret; the phone proves it holds it with an HMAC, both
 *   screens show the same six-digit code, and the pairing completes only when
 *   it is approved on the PC (the usual approval prompt) and on the phone. It
 *   expires in five minutes and dies after five bad attempts.
 *
 *   A per-device key that never travels again. Pairing hands the phone a
 *   random 32-byte key over the pinned TLS channel. Every later connection is
 *   a fresh challenge: the desktop sends a nonce, the phone answers with an
 *   HMAC of it. The key itself is stored with DPAPI here and the Android
 *   Keystore there.
 *
 * Requests carry an id. The phone remembers recent ids and answers a repeat
 * from memory rather than acting twice, and this side never resends an action
 * (a call, a WhatsApp draft) after a dropped connection: it says the phone
 * may or may not have done it. The phone only ever answers a fixed list of
 * operations; nothing it sends is executed here.
 */

import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { WebSocketServer } from 'ws'
import { ToolError, ERR } from '../tools/registry.mjs'

export const PROTOCOL = 1
const PAIR_TTL_MS = 5 * 60_000
const PAIR_MAX_ATTEMPTS = 5
const HELLO_TIMEOUT_MS = 10_000
const CONFIRM_TIMEOUT_MS = 90_000
const HEARTBEAT_MS = 20_000
const MAX_MESSAGE = 256 * 1024
const MAX_UNAUTHENTICATED = 6

// ---------------------------------------------------------------------------
// Primitives shared with the phone (and its tests)
// ---------------------------------------------------------------------------

export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
export const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex')

/** Constant-time comparison of two strings of hex or base64. */
export function same(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** The six digits both screens show while pairing. */
export function verificationCode(secret, deviceId, nonce) {
  const h = crypto.createHash('sha256').update(`sas|${secret}|${deviceId}|${nonce}`).digest()
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export const pairProof = (secret, pid, deviceId, nonce, fp) => hmac(fromB64url(secret), `pair|${pid}|${deviceId}|${nonce}|${fp}`)
export const authProof = (token, deviceId, nonce, fp) => hmac(fromB64url(token), `auth|${deviceId}|${nonce}|${fp}`)

/** Lower-case hex SHA-256 of the certificate, no separators. */
export const fingerprintOf = (pem) => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase()

/** RFC 1918, link-local and loopback: the only places a phone on the same Wi-Fi can be. */
export function isPrivateAddress(ip) {
  const v4 = String(ip).replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return /^(fe80:|fc|fd|::1$)/i.test(String(ip))
}

/** This PC's addresses on private networks, i.e. where the phone can reach it. */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Virtual switches for WSL, Hyper-V and Docker are private too, but no phone is on them.
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback/i.test(name)) continue
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address) && !a.address.startsWith('169.254.')) out.push(a.address)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// What may arrive from a phone. Everything else closes the socket.
// ---------------------------------------------------------------------------

const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
const hello = z.discriminatedUnion('mode', [
  z.object({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL),
    mode: z.literal('pair'),
    pid: z.string().min(8).max(64),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    proof: z.string().regex(/^[0-9a-f]{64}$/),
    device: z.object({ id: deviceIdSchema, name: z.string().min(1).max(60), model: z.string().max(60).optional(), android: z.string().max(20).optional() }),
  }),
  z.object({ t: z.literal('hello'), v: z.literal(PROTOCOL), mode: z.literal('auth'), deviceId: deviceIdSchema }),
])
const authReply = z.object({ t: z.literal('auth'), mac: z.string().regex(/^[0-9a-f]{64}$/) })
const pairConfirm = z.object({ t: z.literal('pair-confirm'), accept: z.boolean() })
const fromPhone = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('res'),
    id: z.string().uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string().max(40), message: z.string().max(500) }).optional(),
  }),
  z.object({
    t: z.literal('status'),
    battery: z.object({ level: z.number().min(0).max(100).nullable(), charging: z.boolean().nullable() }).optional(),
    permissions: z.record(z.string().max(30), z.string().max(20)).optional(),
    enabled: z.record(z.string().max(30), z.boolean()).optional(),
    app: z.string().max(20).optional(),
  }),
  z.object({ t: z.literal('bye'), reason: z.enum(['revoked', 'disconnect']) }),
])

/** Error codes a phone may report, mapped onto the registry's. */
const PHONE_ERRORS = {
  PERMISSION_DENIED: ERR.PERMISSION_DENIED,
  CAPABILITY_DISABLED: ERR.PERMISSION_DENIED,
  LOCATION_OFF: ERR.PERMISSION_DENIED,
  NOT_FOUND: ERR.NOT_FOUND,
  UNSUPPORTED: ERR.UNSUPPORTED,
  INVALID_ARGS: ERR.INVALID_ARGS,
  EXPIRED: ERR.TIMEOUT,
  BUSY: ERR.RATE_LIMITED,
  FAILED: ERR.FAILED,
  EMERGENCY_REFUSED: ERR.PERMISSION_DENIED,
}

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg))

// ---------------------------------------------------------------------------

/**
 * @param {{
 *   secrets: { get(k:string): Promise<any>, set(k:string, v:any): Promise<void>, remove(k:string): Promise<void> },
 *   stateFile: string,
 *   audit?: (e: object) => void,
 *   port?: number,
 *   hosts?: () => string[],
 *   now?: () => number,
 *   makeCert?: () => { cert: string, key: string },
 *   name?: string,
 * }} opts
 */
export function companionHub({
  secrets,
  stateFile,
  audit = () => {},
  port = Number(process.env.JARVIS_COMPANION_PORT ?? 8790),
  hosts = lanAddresses,
  now = Date.now,
  makeCert,
  name = os.hostname(),
}) {
  /** deviceId → live authenticated session */
  const sessions = new Map()
  /** id → { resolve, reject, timer, deviceId, op } */
  const pending = new Map()
  /** Battery and permissions, as each phone last reported them. */
  const reported = new Map()
  let servers = []
  let listening = []
  let tls = null
  let pairing = null
  let confirmer = null
  let unauthenticated = 0
  let rebindTimer = null
  let starting = null

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch {
      return { desktopId: b64url(crypto.randomBytes(12)), devices: {} }
    }
  }
  const save = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 })
  }
  let state = load()
  if (!fs.existsSync(stateFile)) save(state)

  const tokens = async () => (await secrets.get('companion-tokens')) ?? {}

  async function certificate() {
    if (tls) return tls
    let saved = await secrets.get('companion-tls')
    if (!saved?.cert || !saved?.key) {
      const made = makeCert ? makeCert() : await generateCert()
      saved = { cert: made.cert, key: made.key }
      await secrets.set('companion-tls', saved)
      audit({ event: 'companion', action: 'certificate_created' })
    }
    tls = { ...saved, fp: fingerprintOf(saved.cert) }
    return tls
  }

  // -------------------------------------------------------------------------
  // Listening, on the private-network addresses only
  // -------------------------------------------------------------------------

  async function bind() {
    const want = [...new Set(hosts())].sort()
    if (want.join() === listening.join() && servers.length) return
    for (const s of servers) s.close()
    servers = []
    listening = []
    const { cert, key } = await certificate()
    for (const host of want) {
      const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, (_req, res) => {
        res.writeHead(404)
        res.end()
      })
      const wss = new WebSocketServer({ server, path: '/companion', maxPayload: MAX_MESSAGE })
      wss.on('connection', onConnection)
      await new Promise((resolve) => {
        server.once('error', (err) => {
          audit({ event: 'companion', action: 'listen_failed', host, code: err.code })
          resolve()
        })
        server.listen(port, host, () => {
          servers.push(server)
          listening.push(host)
          resolve()
        })
      })
    }
  }

  /** Start listening if anything needs it: a paired phone or a pairing in progress. */
  async function ensureStarted() {
    if (servers.length) return
    starting ??= bind().finally(() => {
      starting = null
    })
    await starting
    // Addresses change (DHCP, a different Wi-Fi). Follow them.
    rebindTimer ??= setInterval(() => void bind().catch(() => {}), 30_000)
    rebindTimer.unref?.()
  }

  function stop() {
    clearInterval(rebindTimer)
    rebindTimer = null
    for (const s of sessions.values()) s.ws.close(1001, 'stopping')
    for (const s of servers) s.close()
    servers = []
    listening = []
  }

  // -------------------------------------------------------------------------
  // One socket, from hello to an authenticated session
  // -------------------------------------------------------------------------

  function onConnection(ws, req) {
    const ip = req.socket.remoteAddress
    if (!isPrivateAddress(ip) || unauthenticated >= MAX_UNAUTHENTICATED) {
      ws.close(1008, 'refused')
      return
    }
    unauthenticated++
    let stage = 'hello'
    let authed = false
    let challenge = null
    let deviceId = null
    const finishUnauth = () => {
      if (!authed && stage !== 'done') {
        stage = 'done'
        unauthenticated--
      }
    }
    const fail = (code, message) => {
      send(ws, { t: 'error', code, message })
      audit({ event: 'companion', action: 'rejected', code, ip })
      ws.close(1008, code)
    }
    const helloTimer = setTimeout(() => fail('TIMEOUT', 'No hello in time.'), HELLO_TIMEOUT_MS)

    ws.on('close', () => {
      clearTimeout(helloTimer)
      finishUnauth()
      if (authed && sessions.get(deviceId)?.ws === ws) dropSession(deviceId, 'closed')
    })
    ws.on('error', () => {})

    ws.on('message', async (raw, isBinary) => {
      let msg
      try {
        if (isBinary) throw new Error('binary')
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        return fail('MALFORMED', 'Not JSON.')
      }

      if (authed) return onSessionMessage(deviceId, msg)

      if (stage === 'hello') {
        const h = hello.safeParse(msg)
        if (!h.success) return fail('MALFORMED', 'Bad hello.')
        clearTimeout(helloTimer)
        if (h.data.mode === 'auth') {
          deviceId = h.data.deviceId
          const dev = state.devices[deviceId]
          if (!dev) return fail('UNKNOWN_DEVICE', 'This phone is not paired with JARVIS. Pair it again.')
          if (dev.paused) return fail('PAUSED', 'JARVIS has this phone disconnected. Reconnect it from the JARVIS console.')
          challenge = b64url(crypto.randomBytes(24))
          stage = 'auth'
          send(ws, { t: 'challenge', nonce: challenge })
          return
        }
        return onPairHello(ws, h.data, ip, fail, (id) => {
          deviceId = id
          stage = 'pair-wait'
        })
      }

      if (stage === 'auth') {
        const a = authReply.safeParse(msg)
        if (!a.success) return fail('MALFORMED', 'Bad auth.')
        const token = (await tokens())[deviceId]
        const ok = token && same(a.data.mac, authProof(token, deviceId, challenge, (await certificate()).fp))
        challenge = null // single use either way
        if (!ok) return fail('AUTH_FAILED', 'Authentication failed. Pair the phone again.')
        finishUnauth()
        authed = true
        stage = 'session'
        openSession(deviceId, ws, ip)
        return
      }

      if (stage === 'pair-wait') {
        const c = pairConfirm.safeParse(msg)
        if (!c.success) return fail('MALFORMED', 'Expected the phone’s confirmation.')
        pairing?.phoneAnswer?.(c.data.accept)
      }
    })
  }

  async function onPairHello(ws, h, ip, fail, setDevice) {
    const p = pairing
    if (!p || now() > p.expiresAt) return fail('PAIRING_EXPIRED', 'That pairing code has expired. Start pairing again on the PC.')
    if (!same(h.pid, p.pid)) return fail('PAIRING_INVALID', 'That pairing code is not the current one.')
    const fp = (await certificate()).fp
    if (!same(h.proof, pairProof(p.secret, p.pid, h.device.id, h.nonce, fp))) {
      p.attempts++
      if (p.attempts >= PAIR_MAX_ATTEMPTS) {
        pairing = null
        audit({ event: 'companion', action: 'pairing_locked' })
      }
      return fail('PAIRING_INVALID', 'The pairing proof did not match.')
    }
    if (p.busy) return fail('BUSY', 'Another phone is pairing right now.')
    p.busy = true
    setDevice(h.device.id)
    const code = verificationCode(p.secret, h.device.id, h.nonce)
    send(ws, { t: 'pair-pending', code, desktop: name })
    audit({ event: 'companion', action: 'pairing_requested', device: h.device.name })

    // Both people say yes, in either order, before the deadline.
    const phoneYes = new Promise((resolve) => {
      p.phoneAnswer = resolve
    })
    const deskYes = confirmer
      ? Promise.resolve(
          confirmer({
            tool: 'phone pairing (Wi-Fi)',
            risk: 'high',
            reason: 'pairs a phone with JARVIS so it can be controlled over Wi-Fi',
            summary: `Phone: ${h.device.name}${h.device.model ? ` (${h.device.model})` : ''}\nCode on the phone: ${code.slice(0, 3)} ${code.slice(3)}\nApprove only if the codes match.`,
          }),
        ).then((r) => r?.approved === true, () => false)
      : Promise.resolve(false)
    // Yes needs both; a no from either side, or the deadline, ends it at once.
    const [desk, phone] = await new Promise((resolve) => {
      const answers = [null, null]
      const timer = setTimeout(() => resolve([answers[0] === true, answers[1] === true]), CONFIRM_TIMEOUT_MS)
      timer.unref?.()
      const settle = (i) => (yes) => {
        answers[i] = yes === true
        if (!answers[i] || answers.every((a) => a === true)) {
          clearTimeout(timer)
          resolve([answers[0] === true, answers[1] === true])
        }
      }
      deskYes.then(settle(0))
      phoneYes.then(settle(1))
    })
    if (pairing === p) pairing = null
    if (!desk || !phone) {
      audit({ event: 'companion', action: 'pairing_declined', by: !desk ? 'pc' : 'phone' })
      return fail('PAIRING_DECLINED', !confirmer ? 'Open the JARVIS screen on the PC to approve pairing.' : 'Pairing was not approved on both devices.')
    }

    const token = b64url(crypto.randomBytes(32))
    const all = await tokens()
    all[h.device.id] = token
    await secrets.set('companion-tokens', all)
    // A phone re-pairing replaces its old record rather than appearing twice.
    for (const [id, d] of Object.entries(state.devices)) {
      if (id !== h.device.id && d.name === h.device.name && d.model === h.device.model) {
        delete state.devices[id]
        delete all[id]
      }
    }
    await secrets.set('companion-tokens', all)
    state.devices[h.device.id] = { name: h.device.name, model: h.device.model ?? null, android: h.device.android ?? null, pairedAt: new Date(now()).toISOString(), paused: false }
    save(state)
    audit({ event: 'companion', action: 'paired', device: h.device.name })
    send(ws, { t: 'paired', token, desktopId: state.desktopId, desktop: name })
    ws.close(1000, 'paired')
  }

  // -------------------------------------------------------------------------
  // Authenticated sessions
  // -------------------------------------------------------------------------

  function openSession(deviceId, ws, ip) {
    // One session per phone: a reconnect replaces a stale socket.
    const old = sessions.get(deviceId)
    if (old && old.ws !== ws) old.ws.close(4000, 'replaced')
    const s = { ws, ip, since: now(), lastSeen: now(), alive: true }
    s.beat = setInterval(() => {
      if (!s.alive) {
        ws.terminate()
        return
      }
      s.alive = false
      ws.ping()
    }, HEARTBEAT_MS)
    s.beat.unref?.()
    ws.on('pong', () => {
      s.alive = true
      s.lastSeen = now()
    })
    sessions.set(deviceId, s)
    state.devices[deviceId] = { ...state.devices[deviceId], lastConnectedAt: new Date(now()).toISOString(), lastIp: ip }
    save(state)
    audit({ event: 'companion', action: 'connected', device: state.devices[deviceId]?.name })
    send(ws, { t: 'welcome', desktop: name, serverTime: now() })
  }

  function dropSession(deviceId, why) {
    const s = sessions.get(deviceId)
    if (!s) return
    clearInterval(s.beat)
    sessions.delete(deviceId)
    if (state.devices[deviceId]) state.devices[deviceId].lastSeenAt = new Date(s.lastSeen).toISOString()
    save(state)
    for (const [id, p] of pending) {
      if (p.deviceId !== deviceId) continue
      pending.delete(id)
      clearTimeout(p.timer)
      p.reject(
        new ToolError(
          ERR.NOT_CONNECTED,
          p.idempotent
            ? 'The phone disconnected before answering.'
            : 'The phone disconnected before answering, so it is not known whether it did this. Check the phone before trying again.',
          { retryable: p.idempotent },
        ),
      )
    }
    audit({ event: 'companion', action: 'disconnected', why })
  }

  function onSessionMessage(deviceId, msg) {
    const s = sessions.get(deviceId)
    if (s) {
      s.lastSeen = now()
      s.alive = true
    }
    const m = fromPhone.safeParse(msg)
    if (!m.success) {
      audit({ event: 'companion', action: 'malformed_message' })
      return
    }
    const d = m.data
    if (d.t === 'status') {
      reported.set(deviceId, { ...reported.get(deviceId), ...d, at: now() })
      return
    }
    if (d.t === 'bye') {
      if (d.reason === 'revoked') void revoke(deviceId, 'phone')
      else s?.ws.close(1000, 'bye')
      return
    }
    const p = pending.get(d.id)
    if (!p || p.deviceId !== deviceId) return // late, duplicate, or not ours
    pending.delete(d.id)
    clearTimeout(p.timer)
    if (d.ok) p.resolve(d.result ?? null)
    else {
      const code = PHONE_ERRORS[d.error?.code] ?? ERR.FAILED
      p.reject(new ToolError(code, d.error?.message ?? 'The phone reported an error.'))
    }
  }

  /** The phone to talk to: the given one, or the one connected most recently. */
  function pick(deviceId) {
    if (deviceId) return sessions.has(deviceId) ? deviceId : null
    let best = null
    for (const [id, s] of sessions) if (!best || s.since > sessions.get(best).since) best = id
    return best
  }

  /**
   * Ask the phone to do one thing.
   *
   * @param {string} op
   * @param {object} args
   * @param {{ signal?: AbortSignal, timeoutMs?: number, idempotent?: boolean, deviceId?: string }} [opts]
   */
  function request(op, args = {}, { signal, timeoutMs = 20_000, idempotent = false, deviceId } = {}) {
    const target = pick(deviceId)
    if (!target) {
      const paired = Object.keys(state.devices).length
      return Promise.reject(
        new ToolError(
          ERR.NOT_CONNECTED,
          paired
            ? 'The phone is paired but not connected over Wi-Fi. Open the JARVIS companion app on it and check both are on the same Wi-Fi.'
            : 'No phone is paired over Wi-Fi. Install the companion app and pair it from the JARVIS console.',
        ),
      )
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new ToolError(ERR.TIMEOUT, idempotent ? 'The phone did not answer in time.' : 'The phone did not answer in time; it is not known whether it did this.', { retryable: idempotent }))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, deviceId: target, op, idempotent })
      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          send(sessions.get(target)?.ws, { t: 'cancel', id })
          reject(new ToolError(ERR.CANCELLED, 'Cancelled.'))
        },
        { once: true },
      )
      send(sessions.get(target).ws, { t: 'req', id, op, args, deadline: now() + timeoutMs })
    })
  }

  // -------------------------------------------------------------------------
  // Pairing, pausing, revoking — driven from the console and the tools
  // -------------------------------------------------------------------------

  async function startPairing() {
    await ensureStarted()
    if (!listening.length) {
      throw new ToolError(ERR.NOT_CONNECTED, 'This PC has no private-network address to listen on. Connect it to your Wi-Fi first.')
    }
    pairing = { pid: b64url(crypto.randomBytes(9)), secret: b64url(crypto.randomBytes(32)), expiresAt: now() + PAIR_TTL_MS, attempts: 0, busy: false }
    const payload = { v: PROTOCOL, pid: pairing.pid, s: pairing.secret, fp: (await certificate()).fp, hosts: listening, port, name, did: state.desktopId }
    pairing.uri = `jarvis-pair:${b64url(JSON.stringify(payload))}`
    audit({ event: 'companion', action: 'pairing_started' })
    for (const fn of listeners) fn({ kind: 'pairing' })
    return { uri: pairing.uri, expiresAt: new Date(pairing.expiresAt).toISOString(), hosts: listening, port }
  }

  /**
   * The QR contents, for the console only. Not part of status() and never
   * returned to the model: it carries the one-time pairing secret.
   */
  const pairingUri = () => (pairing && now() < pairing.expiresAt ? { uri: pairing.uri, expiresAt: new Date(pairing.expiresAt).toISOString() } : null)
  const listeners = new Set()

  function cancelPairing() {
    pairing = null
  }

  function pause(deviceId, paused) {
    if (!state.devices[deviceId]) return false
    state.devices[deviceId].paused = paused
    save(state)
    if (paused) sessions.get(deviceId)?.ws.close(4001, 'paused')
    audit({ event: 'companion', action: paused ? 'paused' : 'resumed' })
    return true
  }

  async function revoke(deviceId, by = 'pc') {
    const had = Boolean(state.devices[deviceId])
    const s = sessions.get(deviceId)
    if (s) {
      send(s.ws, { t: 'revoked' })
      s.ws.close(4002, 'revoked')
      dropSession(deviceId, 'revoked')
    }
    delete state.devices[deviceId]
    reported.delete(deviceId)
    save(state)
    const all = await tokens()
    delete all[deviceId]
    await secrets.set('companion-tokens', all)
    audit({ event: 'companion', action: 'revoked', by })
    return had
  }

  function status() {
    return {
      listening: listening.map((h) => `${h}:${port}`),
      pairing: pairing && now() < pairing.expiresAt ? { active: true, expiresAt: new Date(pairing.expiresAt).toISOString() } : null,
      devices: Object.entries(state.devices).map(([id, d]) => {
        const s = sessions.get(id)
        const r = reported.get(id)
        return {
          id,
          name: d.name,
          model: d.model,
          paired_at: d.pairedAt,
          // "connected" means an authenticated session exists right now, not that it once did.
          connected: Boolean(s),
          paused: Boolean(d.paused),
          last_connected: d.lastConnectedAt ?? null,
          last_seen: s ? new Date(s.lastSeen).toISOString() : (d.lastSeenAt ?? null),
          address: s?.ip?.replace(/^::ffff:/, '') ?? null,
          battery: r?.battery ?? null,
          permissions: r?.permissions ?? null,
          enabled: r?.enabled ?? null,
          app_version: r?.app ?? null,
        }
      }),
    }
  }

  /**
   * If a phone is already paired, be reachable for it from the start — and
   * keep trying if the first attempt fails. Reading the certificate goes
   * through DPAPI, i.e. PowerShell, which at Windows sign-in can take longer
   * than its time limit; one failure used to leave the link off until the
   * next restart (seen for real: "powershell.exe did not finish in time").
   */
  const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000]
  async function autostart() {
    for (let attempt = 0; Object.keys(state.devices).length && !servers.length; attempt++) {
      try {
        await ensureStarted()
        if (attempt) audit({ event: 'companion', action: 'started_after_retry', attempt })
        return
      } catch (err) {
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
        audit({ event: 'companion', action: 'start_failed', error: err.message, retry_in_s: wait / 1000 })
        await new Promise((r) => setTimeout(r, wait).unref?.())
      }
    }
  }

  return {
    ensureStarted,
    autostart,
    stop,
    startPairing,
    cancelPairing,
    pairingUri,
    /** Told when pairing starts, so the HUD can show the QR code. */
    onEvent: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setConfirmer: (fn) => {
      confirmer = fn
    },
    clearConfirmer: (fn) => {
      if (confirmer === fn) confirmer = null
    },
    connected: (deviceId) => Boolean(pick(deviceId)),
    request,
    pause,
    revoke,
    status,
    fingerprint: async () => (await certificate()).fp,
    get port() {
      return port
    },
  }
}

/** A self-signed certificate for this PC, made once. */
async function generateCert() {
  const { default: selfsigned } = await import('selfsigned')
  const pems = selfsigned.generate([{ name: 'commonName', value: `JARVIS ${os.hostname()}` }], { days: 3650, keySize: 2048, algorithm: 'sha256' })
  return { cert: pems.cert, key: pems.private }
}
