/**
 * The phone tools routed over the Wi-Fi companion, with the hub replaced by a
 * recording fake. These prove the routing, the approvals and the truthful
 * results; the real encrypted link is covered in phone/companion.test.mjs, and
 * neither says anything about a real phone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry, createTickets, ToolError, ERR } from './registry.mjs'
import { androidTools, phoneRouter, wifiOnly } from './android.mjs'
import { whatsappConnector, whatsappTools, waNumber } from './whatsapp.mjs'

function harness(tools) {
  const reg = new Registry().add(tools)
  const tickets = createTickets()
  return {
    async call(name, args) {
      const full = [...reg.tools.keys()].find((k) => k.endsWith(`__${name}`))
      const decision = await reg.authorize(full, args)
      if (decision.verdict === 'deny') return { decision, out: null }
      tickets.grant(full, args)
      return { decision, out: await reg.execute(full, args, { tickets }) }
    },
  }
}

/** A hub stand-in that records requests and answers like the app does. */
function fakeHub({ connected = true, answers = {} } = {}) {
  const calls = []
  return {
    calls,
    connected: () => connected,
    status: () => ({ listening: ['192.168.1.3:8790'], pairing: null, devices: [{ id: 'dev_0123456789abcdef', name: 'Pixel 8', connected }] }),
    request: async (op, args, opts) => {
      calls.push({ op, args, idempotent: opts?.idempotent ?? false })
      const a = answers[op]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? a(args) : a
    },
    startPairing: async () => ({ hosts: ['192.168.1.3'], port: 8790, expiresAt: new Date().toISOString(), uri: 'jarvis-pair:SECRET' }),
    pause: () => true,
    revoke: async () => true,
  }
}

const usbUnused = {
  devices: async () => [],
  resolveCallee: async () => {
    throw new Error('the USB path was used')
  },
  location: async () => {
    throw new Error('the USB path was used')
  },
}

const CONTACTS = {
  contacts: [
    { name: 'Rahul Sharma', number: '90595 50221' },
    { name: 'Rahul K', number: '+91 98480 00000' },
    { name: 'Mom', number: '09849012345' },
    { name: 'Police', number: '100' },
  ],
}

test('calls go over Wi-Fi after approval, resolve contacts, and are never resent', async () => {
  const hub = fakeHub({ answers: { 'contacts.search': CONTACTS, 'call.place': { status: 'dialing' } } })
  const { call } = harness(androidTools(usbUnused, hub))
  const mom = await call('phone_call', { contact: 'Mom' })
  assert.equal(mom.decision.verdict, 'confirm')
  assert.equal(mom.out.result.status, 'initiated')
  assert.equal(mom.out.result.link, 'wifi')
  const placed = hub.calls.find((c) => c.op === 'call.place')
  assert.deepEqual(placed.args, { number: '09849012345' })
  assert.equal(placed.idempotent, false, 'a call is never retried')

  assert.equal((await call('phone_call', { contact: 'Rahul' })).out.error.code, ERR.AMBIGUOUS)
  // A contact that is really an emergency number is refused after lookup.
  assert.equal((await call('phone_call', { contact: 'Police' })).out.error.code, ERR.PERMISSION_DENIED)
  assert.equal((await call('phone_call', { number: '112' })).decision.verdict, 'deny')
  assert.equal(hub.calls.filter((c) => c.op === 'call.place').length, 1)
})

test('a remembered USB serial does not divert a call away from a working Wi-Fi link', async () => {
  const hub = fakeHub({ answers: { 'contacts.search': { contacts: [{ name: 'Habib', number: '+91 98765 43210' }] }, 'call.place': { status: 'dialing' } } })
  const { call } = harness(androidTools(usbUnused, hub))
  const r = await call('phone_call', { contact: 'Habib', serial: '10MG7RFBGH0008B' })
  assert.equal(r.out.result.link, 'wifi')
  assert.equal(r.out.result.status, 'initiated')
  const found = (await call('phone_contacts', { query: 'Habib', serial: '10MG7RFBGH0008B' })).out.result
  assert.equal(found.link, 'wifi')
})

test('with USB switched off, adb is never used and the Wi-Fi state is what gets reported', async () => {
  let adbUsed = false
  const usb = { ...usbUnused, adbRun: async () => { adbUsed = true }, shell: async () => { adbUsed = true }, target: async () => { adbUsed = true } }
  const { call } = harness(androidTools(wifiOnly(usb), fakeHub({ connected: false })))
  const r = (await call('phone_call', { number: '+919876543210' })).out
  assert.equal(r.error.code, ERR.NOT_CONNECTED)
  assert.match(r.error.message, /Wi-Fi/)
  assert.deepEqual((await call('phone_status', {})).out.result.usb.devices, [])
  assert.equal(adbUsed, false)
})

test('a disconnected companion is reported, not simulated', async () => {
  const hub = fakeHub({ connected: false })
  const usbDown = {
    ...usbUnused,
    target: async () => {
      throw new ToolError(ERR.NOT_CONNECTED, 'No phone is paired.')
    },
    resolveCallee: async () => ({ number: '+919059550220', name: null }),
  }
  const { call } = harness(androidTools(usbDown, hub))
  assert.equal((await call('phone_dial', { number: '+919059550220' })).out.error.code, ERR.NOT_CONNECTED)
  assert.equal(hub.calls.length, 0)
  const status = (await call('phone_status', {})).out.result
  assert.equal(status.active_link, 'none')
  assert.equal(status.wifi.devices[0].connected, false)
})

test('a missing Android permission comes through as it is', async () => {
  const hub = fakeHub({ answers: { 'location.get': new ToolError(ERR.PERMISSION_DENIED, 'Location permission is not granted in the companion app.') } })
  const { out } = await harness(androidTools(usbUnused, hub)).call('phone_location', {})
  assert.equal(out.error.code, ERR.PERMISSION_DENIED)
  assert.match(out.error.message, /companion app/)
})

test('location: fresh and stale fixes are labelled', async () => {
  const hub = fakeHub({
    answers: {
      'location.get': (a) => ({ latitude: 17.385, longitude: 78.4867, accuracy_m: 9, fixed_at: '2026-10-29T10:00:00Z', age_seconds: a.fresh ? 6 : 3600, provider: 'fused', fresh: a.fresh }),
    },
  })
  const { call } = harness(androidTools(usbUnused, hub))
  const fresh = (await call('phone_location', {})).out.result
  assert.deepEqual([fresh.stale, fresh.age_minutes, fresh.source], [false, 0.1, 'paired phone over Wi-Fi'])
  const old = (await call('phone_location', { fresh: false })).out.result
  assert.equal(old.stale, true)
})

test('dialer: a notification when Android blocks a background app, and never a call', async () => {
  const hub = fakeHub({ answers: { 'call.dial': { status: 'notification_posted' } } })
  const r = (await harness(androidTools(usbUnused, hub)).call('phone_dial', { number: '112' })).out.result
  assert.equal(r.status, 'notification_posted')
  assert.match(r.note, /Nothing has been called/)
})

test('pairing from voice never hands the QR secret to the model', async () => {
  const { out } = await harness(androidTools(usbUnused, fakeHub())).call('phone_wifi_pair', {})
  assert.equal(out.result.status, 'waiting_for_phone')
  assert.doesNotMatch(JSON.stringify(out), /SECRET|jarvis-pair/)
})

test('WhatsApp on the phone: contact lookup, country code, approval shows the exact message, never "sent"', async () => {
  const prev = process.env.JARVIS_DEFAULT_COUNTRY_CODE
  process.env.JARVIS_DEFAULT_COUNTRY_CODE = '91'
  try {
    const hub = fakeHub({
      answers: {
        'contacts.search': CONTACTS,
        'location.get': { latitude: 17.385, longitude: 78.4867, accuracy_m: 9, age_seconds: 30, provider: 'fused' },
        'whatsapp.prepare': { status: 'opened' },
      },
    })
    const { call } = harness(whatsappTools(whatsappConnector({ desktop: null, env: {}, phone: phoneRouter(usbUnused, hub) })))
    const { decision, out } = await call('whatsapp_prepare_on_phone', { contact: 'Mom', text: 'Here I am', include_location: true })
    assert.equal(decision.verdict, 'confirm')
    assert.match(decision.summary, /Mom \+919849012345/)
    assert.match(decision.summary, /17\.385000,78\.486700/)
    assert.equal(out.result.status, 'draft_opened_on_phone')
    assert.equal(out.result.sent, false)
    const prep = hub.calls.find((c) => c.op === 'whatsapp.prepare')
    assert.equal(prep.args.phone, '919849012345')
    assert.ok(prep.args.text.startsWith('Here I am\nhttps://www.google.com/maps/'))
    assert.equal(hub.calls.filter((c) => c.op === 'location.get').length, 1, 'the approved location is the one sent')
    assert.equal(waNumber('9059550220'), '919059550220')
    assert.equal(waNumber('+44 7700 900123'), '447700900123')
  } finally {
    if (prev === undefined) delete process.env.JARVIS_DEFAULT_COUNTRY_CODE
    else process.env.JARVIS_DEFAULT_COUNTRY_CODE = prev
  }
  const offline = harness(whatsappTools(whatsappConnector({ desktop: null, env: {}, phone: phoneRouter(usbUnused, fakeHub({ connected: false })) })))
  const r = await offline.call('whatsapp_prepare_on_phone', { phone: '+447700900123', text: 'hi' })
  assert.equal(r.out.error.code, ERR.NOT_CONNECTED)
})
