/**
 * The Wi-Fi link, end to end over real TLS on 127.0.0.1, with a scripted
 * phone. These are mock-phone tests: they prove the desktop side of the
 * protocol and its refusals, not that the Android app is installed anywhere.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import selfsigned from 'selfsigned'
import WebSocket from 'ws'
import { companionHub, pairProof, authProof, verificationCode, fromB64url, b64url, isPrivateAddress } from './companion.mjs'
import { ERR } from '../tools/registry.mjs'

const PORT = 18790 + Math.floor(Math.random() * 500)
const pems = selfsigned.generate([{ name: 'commonName', value: 'test' }], { days: 1, keySize: 1024, algorithm: 'sha256' })
const CERT = { cert: pems.cert, key: pems.private }

const memSecrets = () => {
  const m = new Map()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, structuredClone(v)), remove: async (k) => void m.delete(k), m }
}

let clock = Date.now()
const events = []
let hub
let deskAnswer = true
let secrets

function makeHub() {
  secrets = memSecrets()
  return companionHub({
    secrets,
    stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-comp-')), 'companion.json'),
    audit: (e) => events.push(e),
    port: PORT,
    hosts: () => ['127.0.0.1'],
    now: () => clock,
    makeCert: () => CERT,
    name: 'TEST-PC',
  })
}

/**
 * A phone, as the app behaves: pins the fingerprint from the QR code and
 * refuses any other certificate.
 */
function connect(fp) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/companion`, {
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    })
    const inbox = []
    const waiters = []
    ws.on('upgrade', (res) => {
      const got = new crypto.X509Certificate(res.socket.getPeerCertificate(true).raw).fingerprint256.replace(/:/g, '').toLowerCase()
      if (got !== fp) {
        ws.terminate()
        reject(new Error('certificate pin mismatch'))
      }
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      const w = waiters.shift()
      if (w) w(m)
      else inbox.push(m)
    })
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
    ws.on('open', () =>
      resolve({
        ws,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        next: () => new Promise((r) => (inbox.length ? r(inbox.shift()) : waiters.push(r))),
        onMessage: (fn) => ws.on('message', (raw) => fn(JSON.parse(raw.toString()))),
      }),
    )
    ws.on('error', reject)
  })
}

const parseUri = (uri) => JSON.parse(fromB64url(uri.slice('jarvis-pair:'.length)).toString())

async function pairPhone({ deviceId = b64url(crypto.randomBytes(16)), phoneAccepts = true, tamper = false } = {}) {
  const { uri } = await hub.startPairing()
  const qr = parseUri(uri)
  const phone = await connect(qr.fp)
  const nonce = b64url(crypto.randomBytes(16))
  phone.send({
    t: 'hello',
    v: 1,
    mode: 'pair',
    pid: qr.pid,
    nonce,
    proof: tamper ? 'f'.repeat(64) : pairProof(qr.s, qr.pid, deviceId, nonce, qr.fp),
    device: { id: deviceId, name: 'Pixel 8', model: 'Pixel 8' },
  })
  const first = await phone.next()
  if (first.t !== 'pair-pending') return { first, phone, qr, deviceId }
  assert.equal(first.code, verificationCode(qr.s, deviceId, nonce))
  phone.send({ t: 'pair-confirm', accept: phoneAccepts })
  const done = await phone.next()
  return { first, done, phone, qr, deviceId }
}

async function authPhone(deviceId, token, fp, { badMac = false } = {}) {
  const phone = await connect(fp)
  phone.send({ t: 'hello', v: 1, mode: 'auth', deviceId })
  const ch = await phone.next()
  if (ch.t !== 'challenge') return { phone, reply: ch }
  phone.send({ t: 'auth', mac: badMac ? '0'.repeat(64) : authProof(token, deviceId, ch.nonce, fp) })
  return { phone, reply: await phone.next() }
}

before(() => {
  hub = makeHub()
  hub.setConfirmer(async () => ({ approved: deskAnswer }))
})
after(() => hub.stop())

test('only private-network addresses may connect', () => {
  for (const ip of ['192.168.1.20', '10.0.0.5', '172.20.1.1', '::ffff:192.168.0.9', '127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:4860::1']) assert.equal(isPrivateAddress(ip), false, ip)
})

let paired

test('pairing: QR secret + matching code + approval on both devices issues a device key', async () => {
  const r = await pairPhone()
  assert.equal(r.done.t, 'paired')
  assert.equal(fromB64url(r.done.token).length, 32)
  assert.equal(hub.status().devices.length, 1)
  assert.equal(hub.status().devices[0].connected, false, 'paired is not the same as connected')
  paired = { deviceId: r.deviceId, token: r.done.token, fp: r.qr.fp }
  assert.ok(!JSON.stringify(events).includes(r.done.token), 'the key never reaches the audit log')
})

test('the certificate the phone sees is the one in the QR code, and a wrong pin is refused', async () => {
  await assert.rejects(connect('00'.repeat(32)), /pin mismatch/)
})

test('a wrong proof is refused, and five wrong proofs end the pairing', async () => {
  const bad = await pairPhone({ tamper: true })
  assert.deepEqual([bad.first.t, bad.first.code], ['error', 'PAIRING_INVALID'])
  for (let i = 0; i < 4; i++) await pairPhone({ tamper: true }).catch(() => {})
  // pairPhone starts a fresh pairing each time, so lock the current one deliberately:
  const { uri } = await hub.startPairing()
  const qr = parseUri(uri)
  for (let i = 0; i < 5; i++) {
    const p = await connect(qr.fp)
    p.send({ t: 'hello', v: 1, mode: 'pair', pid: qr.pid, nonce: b64url(crypto.randomBytes(16)), proof: 'a'.repeat(64), device: { id: b64url(crypto.randomBytes(16)), name: 'Evil' } })
    await p.next()
  }
  assert.equal(hub.status().pairing, null)
  assert.ok(events.some((e) => e.action === 'pairing_locked'))
})

test('an expired pairing code is refused', async () => {
  const { uri } = await hub.startPairing()
  const qr = parseUri(uri)
  clock += 6 * 60_000
  const p = await connect(qr.fp)
  const id = b64url(crypto.randomBytes(16))
  const nonce = b64url(crypto.randomBytes(16))
  p.send({ t: 'hello', v: 1, mode: 'pair', pid: qr.pid, nonce, proof: pairProof(qr.s, qr.pid, id, nonce, qr.fp), device: { id, name: 'Late' } })
  assert.equal((await p.next()).code, 'PAIRING_EXPIRED')
})

test('pairing declined on either device stores nothing', async () => {
  deskAnswer = false
  const pcNo = await pairPhone()
  assert.equal(pcNo.done.code, 'PAIRING_DECLINED')
  deskAnswer = true
  const phoneNo = await pairPhone({ phoneAccepts: false })
  assert.equal(phoneNo.done.code, 'PAIRING_DECLINED')
  assert.equal(hub.status().devices.length, 1)
})

test('authentication: a fresh challenge each time; wrong keys and unknown phones are refused', async () => {
  const good = await authPhone(paired.deviceId, paired.token, paired.fp)
  assert.equal(good.reply.t, 'welcome')
  assert.equal(hub.status().devices[0].connected, true)
  good.phone.ws.close()
  await good.phone.closed
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(hub.status().devices[0].connected, false, 'connected drops when the socket does')

  const wrong = await authPhone(paired.deviceId, paired.token, paired.fp, { badMac: true })
  assert.equal(wrong.reply.code, 'AUTH_FAILED')
  const stranger = await authPhone(b64url(crypto.randomBytes(16)), paired.token, paired.fp)
  assert.equal(stranger.reply.code, 'UNKNOWN_DEVICE')
  // A replayed answer to an old challenge does not work on a new one.
  const p = await connect(paired.fp)
  p.send({ t: 'hello', v: 1, mode: 'auth', deviceId: paired.deviceId })
  const ch1 = await p.next()
  const replay = authProof(paired.token, paired.deviceId, 'an-old-nonce-value-xx', paired.fp)
  assert.notEqual(ch1.nonce, 'an-old-nonce-value-xx')
  p.send({ t: 'auth', mac: replay })
  assert.equal((await p.next()).code, 'AUTH_FAILED')
})

test('garbage before authentication closes the socket', async () => {
  const p = await connect(paired.fp)
  p.send({ t: 'req', id: crypto.randomUUID(), op: 'shell', args: { cmd: 'rm -rf /' } })
  assert.equal((await p.next()).code, 'MALFORMED')
  const c = await p.closed
  assert.equal(c.code, 1008)
})

async function connectedPhone(handler) {
  const { phone, reply } = await authPhone(paired.deviceId, paired.token, paired.fp)
  assert.equal(reply.t, 'welcome')
  phone.onMessage((m) => m.t === 'req' && handler(m, phone))
  return phone
}

test('requests: results, phone errors mapped, unknown and duplicate replies ignored', async () => {
  const seen = []
  const phone = await connectedPhone((m, ph) => {
    seen.push(m)
    if (m.op === 'location.get') {
      ph.send({ t: 'res', id: m.id, ok: true, result: { latitude: 17.4, longitude: 78.5 } })
      ph.send({ t: 'res', id: m.id, ok: true, result: { latitude: 0, longitude: 0 } }) // a duplicate: ignored
    }
    if (m.op === 'contacts.search') ph.send({ t: 'res', id: m.id, ok: false, error: { code: 'PERMISSION_DENIED', message: 'Contacts permission is off.' } })
  })
  assert.deepEqual(await hub.request('location.get', { fresh: true }, { idempotent: true }), { latitude: 17.4, longitude: 78.5 })
  await assert.rejects(hub.request('contacts.search', { query: 'Rahul' }), (e) => e.code === ERR.PERMISSION_DENIED && /Contacts/.test(e.message))
  assert.ok(seen[0].deadline > clock, 'each request carries a deadline')
  assert.notEqual(seen[0].id, seen[1].id, 'each request has its own id')
  phone.ws.close()
  await phone.closed
})

test('timeouts, cancellation and a dropped connection are reported truthfully', async () => {
  let cancelled = null
  const phone = await connectedPhone(() => {})
  phone.onMessage((m) => m.t === 'cancel' && (cancelled = m.id))
  await assert.rejects(hub.request('location.get', {}, { timeoutMs: 80, idempotent: true }), (e) => e.code === ERR.TIMEOUT)

  const ac = new AbortController()
  const p = hub.request('location.get', {}, { signal: ac.signal })
  setTimeout(() => ac.abort(), 30)
  await assert.rejects(p, (e) => e.code === ERR.CANCELLED)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(cancelled, 'the phone was told to cancel')

  const call = hub.request('call.place', { number: '+919059550220' }, { idempotent: false })
  setTimeout(() => phone.ws.terminate(), 30)
  await assert.rejects(call, (e) => e.code === ERR.NOT_CONNECTED && /not known whether/.test(e.message))
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(hub.request('status.get'), (e) => e.code === ERR.NOT_CONNECTED)
})

test('status reports battery and permissions only as the phone reported them', async () => {
  const phone = await connectedPhone(() => {})
  phone.send({ t: 'status', battery: { level: 64, charging: false }, permissions: { location: 'granted', contacts: 'denied' }, enabled: { calls: true }, app: '1.0.0' })
  await new Promise((r) => setTimeout(r, 50))
  const d = hub.status().devices[0]
  assert.equal(d.battery.level, 64)
  assert.equal(d.permissions.contacts, 'denied')
  phone.ws.close()
  await phone.closed
})

test('disconnect (pause) refuses the phone until reconnected; revoke deletes its key and tells it', async () => {
  hub.pause(paired.deviceId, true)
  const paused = await authPhone(paired.deviceId, paired.token, paired.fp)
  assert.equal(paused.reply.code, 'PAUSED')
  hub.pause(paired.deviceId, false)

  const phone = await connectedPhone(() => {})
  const got = phone.next()
  await hub.revoke(paired.deviceId)
  assert.equal((await got).t, 'revoked')
  assert.equal(hub.status().devices.length, 0)
  assert.deepEqual(await secrets.get('companion-tokens'), {})
  const after = await authPhone(paired.deviceId, paired.token, paired.fp)
  assert.equal(after.reply.code, 'UNKNOWN_DEVICE')
})
