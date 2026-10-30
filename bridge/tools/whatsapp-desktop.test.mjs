/**
 * The WhatsApp handoff on this PC, from the tool call through approval to
 * the program that is started. No WhatsApp account or window is touched:
 * run() is replaced with a fake that records each program and answers as
 * Windows did when this was measured, so these prove what JARVIS asks
 * Windows to do and what it then reports.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Registry, createTickets, ERR } from './registry.mjs'
import { whatsappConnector, whatsappTools, waNumber } from './whatsapp.mjs'
import { windowsWhatsApp, desktopLink, webLink, MAX_LINK } from './whatsapp-desktop.mjs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/**
 * Windows, faked. `installed` is whether WhatsApp Desktop registered the
 * whatsapp: protocol; `running` whether its process shows up after the link
 * is opened; `startFails` makes the ShellExecute launcher (rundll32) fail.
 */
function fakeWindows({ installed = true, running = true, startFails = false, chrome = true, online = true } = {}) {
  const calls = []
  let launched = false
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args, env: opts.env })
    if (file === 'reg.exe') return { stdout: '', stderr: '', code: installed ? 0 : 1 }
    if (file === 'rundll32.exe') {
      if (startFails) return { stdout: '', stderr: 'Error in url.dll', code: 1 }
      if (args[1].startsWith('whatsapp:')) launched = true
      return { stdout: '', stderr: '', code: 0 }
    }
    if (file === 'tasklist.exe') return { stdout: launched && running ? '"WhatsApp.Root.exe","400","Console","1","250,000 K"\r\n' : '"explorer.exe","1","Console","1","1 K"\r\n', stderr: '', code: 0 }
    if (file === CHROME) return { stdout: '', stderr: '', code: 0 }
    throw new Error(`unexpected program ${file}`)
  }
  const desktop = windowsWhatsApp({
    run,
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: (p) => chrome && p === CHROME,
    resolve: async () => (online ? { address: '1.2.3.4' } : Promise.reject(new Error('ENOTFOUND'))),
  })
  return { calls, desktop, opened: () => calls.filter((c) => c.file === 'rundll32.exe' || c.file === CHROME) }
}

/** authorize → (approve) → ticket → execute, the way the bridge's hook runs it. */
function bridge(tools) {
  const reg = new Registry().add(tools)
  const tickets = createTickets()
  const notes = []
  return {
    notes,
    async call(name, args, { approve = true } = {}) {
      const full = `mcp__jarvis_whatsapp__${name}`
      const decision = await reg.authorize(full, args)
      if (decision.verdict === 'deny' || (decision.verdict === 'confirm' && !approve)) return { decision, out: null }
      tickets.grant(full, args)
      return { decision, out: await reg.execute(full, args, { tickets, progress: (n) => notes.push(n) }) }
    },
  }
}

const setup = (win = {}, extra = {}) => {
  const w = fakeWindows(win)
  const audit = []
  const wa = whatsappConnector({ desktop: w.desktop, env: {}, audit: (e) => audit.push(e), ...extra })
  return { ...w, wa, audit, ...bridge(whatsappTools(wa)) }
}

describe('recipient numbers', () => {
  test('Indian numbers in every way people write them', () => {
    for (const raw of ['+91 90595 50220', '+91-905-955-0220', '+91 (0) 90595 50220', '+910 9059550220', '0091 9059550220', '919059550220']) {
      assert.equal(waNumber(raw, '91'), '919059550220', raw)
    }
    // Local numbers get the default country code; the trunk 0 is dropped.
    assert.equal(waNumber('9059550220', '91'), '919059550220')
    assert.equal(waNumber('09059550220', '91'), '919059550220')
    // Not ten digits after 91: a typo that would open someone else's chat.
    for (const raw of ['+91 90595 5022', '+91 90595 502201', '+91 0 0595 50220', '905955', '+91']) {
      assert.equal(waNumber(raw, '91'), null, raw)
    }
    // Without a default country code, a local number is refused, not guessed.
    assert.equal(waNumber('09059550220', ''), null)
    assert.equal(waNumber('+44 7700 900123', '91'), '447700900123')
  })

  test('an invalid number is refused before the approval prompt, and nothing opens', async () => {
    const s = setup()
    const { decision, out } = await s.call('whatsapp_open_chat', { phone: '+91 90595 5022', text: 'hi' })
    assert.equal(decision.verdict, 'deny')
    assert.equal(out, null)
    assert.equal(s.calls.length, 0)
  })
})

describe('links', () => {
  const hard = 'Hi Ayman 👋 & team,\nMeet at 5? 50% off #deal + "quotes" / slash\nनमस्ते 🙏🏽'

  test('the text survives the link exactly: spaces, emoji, punctuation, ampersands, new lines', () => {
    for (const link of [desktopLink('919059550220', hard), webLink('919059550220', hard)]) {
      const u = new URL(link)
      assert.equal(u.searchParams.get('phone'), '919059550220')
      assert.equal(u.searchParams.get('text'), hard)
      assert.equal([...u.searchParams.keys()].length, 2, 'an & in the text did not start a new parameter')
      assert.doesNotMatch(link, /[\s"<>\n]/)
    }
    assert.equal(desktopLink('919059550220'), 'whatsapp://send?phone=919059550220')
  })

  test('WhatsApp Desktop gets its own whatsapp: link, not wa.me in a browser', async () => {
    const s = setup()
    await s.call('whatsapp_open_chat', { phone: '+91 90595 50220', text: hard })
    const [launch] = s.opened()
    assert.equal(launch.file, 'rundll32.exe')
    assert.deepEqual(launch.args, ['url.dll,FileProtocolHandler', desktopLink('919059550220', hard)])
    assert.ok(!s.calls.some((c) => c.file === 'explorer.exe' || c.args.some((a) => a.includes('wa.me'))))
  })

  test('a message is one encoded argument, never a command', async () => {
    const s = setup()
    const evil = '" & calc.exe & "%PATH%\' ; Remove-Item C:\\ -Recurse $(calc)`'
    await s.call('whatsapp_open_chat', { phone: '+919059550220', text: evil })
    const launch = s.calls.find((c) => c.file === 'rundll32.exe')
    assert.equal(launch.args.length, 2)
    assert.doesNotMatch(launch.args[1], /[\s"&%]PATH|[\s"]/)
    assert.equal(new URL(launch.args[1]).searchParams.get('text'), evil)
  })

  test('a link too long for Windows is refused rather than cut short', async () => {
    const w = fakeWindows()
    await assert.rejects(w.desktop.shellOpen(`whatsapp://send?text=${'x'.repeat(MAX_LINK)}`), (e) => e.code === ERR.INVALID_ARGS)
    assert.equal(w.calls.length, 0)
  })
})

describe('the handoff after ALLOW', () => {
  test('regression: a launcher that exits non-zero is a failure, not "opened"', async () => {
    // The old code ran explorer.exe, which exits 1 whether or not anything
    // opened, ignored the code and reported draft_opened. Now a failed start
    // is an error, and with no Chrome either there is nothing to claim.
    const s = setup({ startFails: true, chrome: false })
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })
    assert.equal(out.ok, false)
    assert.equal(out.error.code, ERR.FAILED)
    assert.doesNotMatch(JSON.stringify(out), /awaiting_user_send|draft_opened/)
  })

  test('Desktop installed: approved → opening → handed off → awaiting the user, and never "sent"', async () => {
    const s = setup()
    const { decision, out } = await s.call('whatsapp_open_chat', { phone: '+91 90595 50220', text: 'On my way' })
    assert.equal(decision.verdict, 'confirm')
    assert.match(decision.summary, /WhatsApp Desktop/)
    assert.match(decision.summary, /\+919059550220/)
    assert.match(decision.summary, /On my way/)
    assert.equal(out.ok, true)
    assert.equal(out.result.status, 'awaiting_user_send')
    assert.equal(out.result.sent, false)
    assert.equal(out.result.opened_in, 'whatsapp_desktop')
    assert.deepEqual(out.result.states, ['approved', 'opening_whatsapp', 'chat_handed_off', 'awaiting_user_send'])
    assert.match(out.result.note, /Nothing has been sent/)
    assert.match(out.result.note, /QR code|loading screen/)
    assert.deepEqual(s.notes, ['Opening WhatsApp Desktop', 'Chat handed to WhatsApp Desktop, awaiting your send'])
    assert.deepEqual(s.audit, [{ event: 'whatsapp', action: 'open_chat', opened_in: 'whatsapp_desktop', fallback: false, online: true }])
    assert.doesNotMatch(JSON.stringify(s.audit), /9059550220|On my way/, 'the audit log keeps neither number nor text')
  })

  test('declined: nothing opens', async () => {
    const s = setup()
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' }, { approve: false })
    assert.equal(out, null)
    assert.equal(s.calls.length, 0)
  })

  test('without the approval ticket the tool does not run, even if called directly', async () => {
    const s = setup()
    const reg = new Registry().add(whatsappTools(s.wa))
    const out = await reg.execute('mcp__jarvis_whatsapp__whatsapp_open_chat', { phone: '+919059550220', text: 'hi' }, { tickets: createTickets() })
    assert.equal(out.error.code, ERR.UNAUTHORIZED)
    assert.equal(s.calls.length, 0)
  })

  test('WhatsApp Desktop not installed: WhatsApp Web in Chrome, with the reason', async () => {
    const s = setup({ installed: false })
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi & bye' })
    assert.equal(out.result.opened_in, 'whatsapp_web_chrome')
    assert.match(out.result.fallback_reason, /not installed/)
    assert.equal(out.result.sent, false)
    assert.match(out.result.note, /QR code/)
    const chrome = s.calls.find((c) => c.file === CHROME)
    assert.deepEqual(chrome.args, [webLink('919059550220', 'hi & bye')])
    assert.ok(!s.calls.some((c) => c.file === 'rundll32.exe'), 'no whatsapp: link to an app that is not there')
  })

  test('WhatsApp Desktop will not start: falls back to WhatsApp Web', async () => {
    const s = setup({ running: false })
    // No waiting the real eight seconds for a process that will never appear.
    const desktop = { ...s.desktop, openDesktop: (d, t, sig) => s.desktop.openDesktop(d, t, sig, { waitMs: 0 }) }
    const t = bridge(whatsappTools(whatsappConnector({ desktop, env: {} })))
    const { out } = await t.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })
    assert.equal(out.result.opened_in, 'whatsapp_web_chrome')
    assert.match(out.result.fallback_reason, /did not start/)
  })

  test('the launcher fails: falls back to WhatsApp Web', async () => {
    const s = setup({ startFails: true })
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })
    assert.equal(out.result.opened_in, 'whatsapp_web_chrome')
    assert.match(out.result.fallback_reason, /could not be opened/)
  })

  test('no Chrome: WhatsApp Web in the default browser', async () => {
    const s = setup({ installed: false, chrome: false })
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })
    assert.equal(out.result.opened_in, 'whatsapp_web_browser')
    assert.deepEqual(s.calls.find((c) => c.file === 'rundll32.exe').args, ['url.dll,FileProtocolHandler', webLink('919059550220', 'hi')])
  })

  test('logged out or stuck Desktop: the user can ask for WhatsApp Web directly', async () => {
    const s = setup()
    const { decision, out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi', via: 'web' })
    assert.match(decision.summary, /WhatsApp Web in Chrome/)
    assert.equal(out.result.opened_in, 'whatsapp_web_chrome')
    assert.equal(out.result.fallback_reason, undefined)
    assert.ok(!s.calls.some((c) => c.file === 'reg.exe' || c.file === 'rundll32.exe'))
  })

  test('Desktop only, but not installed: a clear error and nothing opened', async () => {
    const s = setup({ installed: false })
    const { out } = await s.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi', via: 'desktop' })
    assert.equal(out.error.code, ERR.NOT_FOUND)
    assert.match(out.error.message, /not installed.*Nothing was opened or sent/)
    assert.equal(s.opened().length, 0)
  })

  test('offline: WhatsApp Web is not opened onto an error page; Desktop still gets the draft, with a warning', async () => {
    const web = setup({ installed: false, online: false })
    const { out } = await web.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })
    assert.equal(out.error.code, ERR.NETWORK)
    assert.match(out.error.message, /offline.*Nothing was opened or sent/)
    assert.equal(web.opened().length, 0)

    const app = setup({ online: false })
    const r = (await app.call('whatsapp_open_chat', { phone: '+919059550220', text: 'hi' })).out.result
    assert.equal(r.opened_in, 'whatsapp_desktop')
    assert.equal(r.offline, true)
    assert.match(r.note, /offline/)
  })
})

describe('duplicate clicks', () => {
  test('the same chat approved twice in quick succession opens once', async () => {
    const s = setup()
    const args = { phone: '+919059550220', text: 'Running late' }
    const [a, b] = await Promise.all([s.call('whatsapp_open_chat', args), s.call('whatsapp_open_chat', args)])
    assert.equal(s.opened().length, 1)
    assert.equal([a, b].filter((r) => r.out.result.duplicate).length, 1)
    const c = await s.call('whatsapp_open_chat', args)
    assert.equal(c.out.result.duplicate, true)
    assert.match(c.out.result.note, /NOT repeated/)
    assert.equal(s.opened().length, 1)
    // A different message is a different chat draft.
    await s.call('whatsapp_open_chat', { ...args, text: 'Running very late' })
    assert.equal(s.opened().length, 2)
  })

  test('after the window, or after a failure, it can be opened again', async () => {
    let t = 0
    const s = setup({}, { now: () => t })
    const args = { phone: '+919059550220', text: 'hi' }
    await s.call('whatsapp_open_chat', args)
    t += 31_000
    await s.call('whatsapp_open_chat', args)
    assert.equal(s.opened().length, 2)

    const f = setup({ installed: false, online: false })
    assert.equal((await f.call('whatsapp_open_chat', args)).out.error.code, ERR.NETWORK)
    assert.equal((await f.call('whatsapp_open_chat', args)).out.error.code, ERR.NETWORK, 'a failure is not replayed as a duplicate success')
  })

  test('the Business API sends one message for two approvals of the same text', async () => {
    const env = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123' }
    let posts = 0
    const fetch = async () => (posts++, new Response(JSON.stringify({ contacts: [{ wa_id: '919059550220' }], messages: [{ id: 'wamid.X' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const s = setup({}, { env, fetch })
    const args = { phone: '+919059550220', text: 'Invoice attached' }
    const [a, b] = await Promise.all([s.call('whatsapp_send', args), s.call('whatsapp_send', args)])
    assert.equal(posts, 1)
    assert.equal(a.out.result.message_id, 'wamid.X')
    assert.equal(b.out.result.message_id, 'wamid.X')
    assert.equal([a, b].filter((r) => r.out.result.duplicate).length, 1)
    assert.ok(s.notes.includes('Sending through the WhatsApp Business API'))
    assert.ok(s.notes.includes('API confirmed: accepted (wamid.X)'))
    assert.equal(a.out.result.status, 'accepted', '"accepted" by the API, never "delivered"')
  })
})
