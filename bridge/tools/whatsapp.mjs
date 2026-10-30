/**
 * WhatsApp, through the two doors WhatsApp actually provides.
 *
 * Personal accounts have no sending API. What exists is click-to-chat, which
 * opens a conversation with the message typed in — and stops there. The
 * person presses send. On this PC that is WhatsApp Desktop's own whatsapp:
 * link, or WhatsApp Web in Chrome when the app is missing or will not start
 * (whatsapp-desktop.mjs). Every result says plainly that nothing was sent.
 * Nothing here automates WhatsApp Web or Desktop, reads their session, or
 * uses any unofficial interface.
 *
 * The WhatsApp Business Platform (Cloud API) does send, for a business number
 * registered with Meta, within Meta's messaging rules. When it is configured,
 * whatsapp_send uses it — and reports "accepted", because that is what the
 * API's reply means. Delivery and read receipts arrive later on a webhook,
 * and only those are reported as delivered.
 *
 * Location: only real coordinates from an authorised source (the paired
 * phone, with its location permission on), or an address the user said,
 * labelled as such. JARVIS never invents a position, and live location
 * sharing is something only the WhatsApp app itself can start.
 */

import { z } from 'zod'
import crypto from 'node:crypto'
import { RISK } from '../policy.mjs'
import { defineTool, ToolError, ERR, runSteps } from './registry.mjs'
import { requestJson } from './http.mjs'
import { normaliseNumber } from './android.mjs'

const SERVER = 'jarvis_whatsapp'

/** A second approval of the same chat or send inside these windows does not repeat it. */
const CHAT_REPEAT_MS = 30_000
const SEND_REPEAT_MS = 120_000

/**
 * International format, digits only, as WhatsApp's links and the Cloud API
 * both want.
 *
 * Contacts are often saved as local numbers ("09059550220", "9059550220").
 * With JARVIS_DEFAULT_COUNTRY_CODE set, those get it; without it they are
 * refused rather than guessed, because a wrong country code is a stranger.
 *
 * Indian numbers are always ten digits after 91, never starting with 0. A
 * trunk 0 written after the code ("+91 0 90595 50220") is dropped; any other
 * length is refused, because 91 followed by nine or eleven digits is a typo
 * that would open a chat with somebody else.
 */
export function waNumber(raw, countryCode = process.env.JARVIS_DEFAULT_COUNTRY_CODE) {
  const n = normaliseNumber(raw)
  if (!n) return null
  let digits = n.replace(/^\+/, '')
  const cc = String(countryCode ?? '').replace(/\D/g, '')
  if (!n.startsWith('+') && cc && !digits.startsWith('00')) {
    const local = digits.replace(/^0+/, '')
    if (local.length <= 10) digits = cc + local
  }
  if (digits.startsWith('00')) digits = digits.slice(2)
  // A trunk 0 left over means a local number with no country code to give it.
  if (digits.startsWith('0')) return null
  if (digits.startsWith('91')) {
    let national = digits.slice(2)
    if (national.length === 11 && national.startsWith('0')) national = national.slice(1)
    if (!/^[1-9]\d{9}$/.test(national)) return null
    digits = `91${national}`
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

export const mapsLink = ({ latitude, longitude }) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`

export const addressLink = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`

/**
 * @param {{ desktop: ReturnType<typeof import('./whatsapp-desktop.mjs').windowsWhatsApp>,
 *           fetch?: typeof fetch, env?: Record<string, string|undefined>,
 *           phone?: ReturnType<typeof import('./android.mjs').androidConnector>,
 *           audit?: (e: object) => void, now?: () => number }} deps
 */
export function whatsappConnector({ desktop, fetch: fetchImpl = globalThis.fetch, env = process.env, phone, audit = () => {}, now = Date.now }) {
  /** Delivery statuses from the webhook, by message id. In memory only. */
  const statuses = new Map()

  /**
   * Chats opened and messages sent lately, by recipient and text. A second
   * approval of the same thing — a double press, or the model asking twice —
   * gets the first one's result back instead of a second chat or message.
   * A failure is forgotten at once, so it can be tried again.
   */
  const recent = new Map()
  function once(kind, digits, text, windowMs, work) {
    for (const [k, v] of recent) if (now() - v.at > v.windowMs) recent.delete(k)
    const key = `${kind}\u0000${digits}\u0000${text ?? ''}`
    const held = recent.get(key)
    if (held) {
      const ago = Math.round((now() - held.at) / 1000)
      return held.promise.then((r) => ({ ...r, duplicate: true, note: `Already done ${ago}s ago for this exact recipient and text, so it was NOT repeated. ${r.note}` }))
    }
    const promise = work()
    recent.set(key, { at: now(), windowMs, promise })
    promise.catch(() => recent.delete(key))
    return promise
  }

  /**
   * Open a chat with the text typed in, for the person to send: WhatsApp
   * Desktop first, WhatsApp Web in Chrome when the app is missing or will not
   * start, or when asked for. Never presses send, never reads the app.
   */
  async function openChat(digits, text, { via = 'auto', signal, progress = () => {} } = {}) {
    return once('chat', digits, text, CHAT_REPEAT_MS, async () => {
      const finish = (openedIn, fallback, online, note) => {
        audit({ event: 'whatsapp', action: 'open_chat', opened_in: openedIn, fallback: Boolean(fallback), online })
        return {
          status: 'awaiting_user_send',
          sent: false,
          to: `+${digits}`,
          opened_in: openedIn,
          ...(fallback ? { fallback_reason: fallback } : {}),
          states: ['approved', 'opening_whatsapp', 'chat_handed_off', 'awaiting_user_send'],
          ...(online ? {} : { offline: true }),
          note,
        }
      }
      let fallback = null
      if (via !== 'web') {
        progress('Opening WhatsApp Desktop')
        if (!(await desktop.desktopInstalled(signal))) fallback = 'WhatsApp Desktop is not installed on this PC'
        else {
          try {
            if (await desktop.openDesktop(digits, text, signal)) {
              const online = await desktop.online()
              progress('Chat handed to WhatsApp Desktop, awaiting your send')
              return finish(
                'whatsapp_desktop',
                null,
                online,
                'The chat link was handed to WhatsApp Desktop, which is running. JARVIS cannot see its window: if it shows this chat with the message typed in, ' +
                  'the user checks it and presses send. If it shows a QR code or login, stays on its loading screen, or says the number is not on WhatsApp, ' +
                  'offer to open it in WhatsApp Web instead (whatsapp_open_chat with via "web"). Nothing has been sent.' +
                  (online ? '' : ' This PC looks offline, so even after send the message waits until the connection returns.'),
              )
            }
            fallback = 'WhatsApp Desktop did not start'
          } catch (err) {
            if (err instanceof ToolError && (err.code === ERR.CANCELLED || err.code === ERR.INVALID_ARGS)) throw err
            fallback = `WhatsApp Desktop could not be opened (${err.message})`
          }
        }
        if (via === 'desktop') throw new ToolError(ERR.NOT_FOUND, `${fallback}. Nothing was opened or sent. WhatsApp Web in Chrome can be used instead.`)
      }
      progress(fallback ? `${fallback}; opening WhatsApp Web` : 'Opening WhatsApp Web')
      if (!(await desktop.online())) {
        throw new ToolError(ERR.NETWORK, `${fallback ? `${fallback}, and this` : 'This'} PC is offline, so WhatsApp Web cannot load. Nothing was opened or sent.`)
      }
      const browser = await desktop.openWeb(digits, text, signal)
      progress(`Chat opened in WhatsApp Web${browser === 'chrome' ? ' (Chrome)' : ''}, awaiting your send`)
      return finish(
        browser === 'chrome' ? 'whatsapp_web_chrome' : 'whatsapp_web_browser',
        fallback,
        true,
        'WhatsApp Web is opening at this chat with the message typed in. If it shows a QR code, the user links it from their phone ' +
          '(WhatsApp → Linked devices); JARVIS does not sign in for them. WhatsApp Web itself says if the number is not on WhatsApp. ' +
          'The user checks the message and presses send. Nothing has been sent.',
      )
    })
  }
  /** The exact location shown in an approval, so what is sent is what was approved. */
  const approvedFixes = new Map()

  const business = () => {
    const token = env.WHATSAPP_TOKEN
    const phoneId = env.WHATSAPP_PHONE_NUMBER_ID
    return token && phoneId ? { token, phoneId, version: env.WHATSAPP_API_VERSION || 'v21.0' } : null
  }

  async function sendBusiness(to, text, signal) {
    const cfg = business()
    if (!cfg) {
      throw new ToolError(
        ERR.NOT_CONFIGURED,
        'The WhatsApp Business API is not configured (WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID). For a personal account use whatsapp_open_chat, which prepares the message for the user to send.',
      )
    }
    const data = await requestJson(fetchImpl, `https://graph.facebook.com/${cfg.version}/${cfg.phoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}` },
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } },
      signal,
      provider: 'WhatsApp',
    })
    const id = data?.messages?.[0]?.id
    if (!id) throw new ToolError(ERR.PROVIDER_ERROR, 'WhatsApp answered without a message id, so the send cannot be confirmed.')
    return { status: 'accepted', message_id: id, to: data?.contacts?.[0]?.wa_id ?? to }
  }

  /** One message per approval: the same text to the same number is not sent twice in a row. */
  const sendOnce = (to, text, signal) =>
    once('send', to, text, SEND_REPEAT_MS, async () => {
      const out = await sendBusiness(to, text, signal)
      audit({ event: 'whatsapp', action: 'api_send', status: out.status })
      return { ...out, note: 'Accepted by WhatsApp. Delivery is confirmed only when a delivery status arrives (whatsapp_delivery_status).' }
    })

  /** The phone's fix, taken once and held for the approval it was shown in. */
  async function fixFor(key, signal) {
    const held = approvedFixes.get(key)
    if (held && Date.now() - held.at < 3 * 60_000) return held.fix
    if (!phone) throw new ToolError(ERR.NOT_CONFIGURED, 'No phone connector is available for location.')
    const fix = await phone.location(undefined, signal)
    approvedFixes.set(key, { fix, at: Date.now() })
    return fix
  }

  /**
   * The exact recipient and text of a phone-side draft, worked out once for
   * the approval prompt and reused when it runs, so what is prepared is what
   * was approved.
   */
  const drafts = new Map()
  const draftKey = (a) => JSON.stringify([a.phone, a.contact, a.text, a.include_location, a.address])
  async function draftFor(a, signal) {
    const key = draftKey(a)
    const held = drafts.get(key)
    if (held && Date.now() - held.at < 3 * 60_000) return held.draft
    let digits
    let name = null
    if (a.contact) {
      if (!phone?.resolveContact) throw new ToolError(ERR.NOT_CONNECTED, 'No phone is connected to look up contacts.')
      const who = await phone.resolveContact(a.contact, signal)
      digits = waNumber(who.number)
      name = who.name
      if (!digits) {
        throw new ToolError(ERR.INVALID_ARGS, `${who.name}'s number (${who.number}) has no country code. Set JARVIS_DEFAULT_COUNTRY_CODE, or give the full number.`)
      }
    } else {
      digits = waNumber(a.phone)
    }
    let fix = null
    let link = null
    if (a.address) link = addressLink(a.address)
    else if (a.include_location) {
      fix = await phone.location(undefined, signal)
      link = mapsLink(fix)
    }
    const text = [a.text, link].filter(Boolean).join('\n')
    const draft = { digits, name, text, fix }
    drafts.set(key, { draft, at: Date.now() })
    return draft
  }

  return {
    business,
    sendBusiness,
    sendOnce,
    openChat,
    fixFor,
    approvedFixes,
    phone,
    draftFor,
    forgetDraft: (a) => drafts.delete(draftKey(a)),
    status: (id) => statuses.get(id) ?? null,

    /**
     * The Cloud API webhook. GET is Meta's subscription check; POST carries
     * statuses, accepted only with a valid X-Hub-Signature-256.
     */
    webhook(method, query, rawBody, headers) {
      if (method === 'GET') {
        const ok = query.get('hub.mode') === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && query.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN
        return ok ? { status: 200, body: query.get('hub.challenge') ?? '' } : { status: 403, body: 'forbidden' }
      }
      const secret = env.WHATSAPP_APP_SECRET
      const sig = String(headers['x-hub-signature-256'] ?? '')
      if (!secret) return { status: 503, body: 'not configured' }
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`
      const a = Buffer.from(sig)
      const b = Buffer.from(expected)
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, body: 'bad signature' }
      let payload
      try {
        payload = JSON.parse(rawBody.toString('utf8'))
      } catch {
        return { status: 400, body: 'bad json' }
      }
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const s of change.value?.statuses ?? []) {
            statuses.set(s.id, {
              status: s.status,
              at: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null,
              ...(s.errors?.length ? { error: s.errors[0].title ?? s.errors[0].message } : {}),
            })
          }
        }
      }
      return { status: 200, body: 'ok' }
    },
  }
}

/** @param {ReturnType<typeof whatsappConnector>} wa */
export function whatsappTools(wa) {
  const recipient = z.string().min(6).max(24).describe('Phone number in international format, e.g. +44 7700 900123.')
  const digitsOf = (raw) => {
    const d = waNumber(raw)
    if (!d) throw new ToolError(ERR.INVALID_ARGS, 'That is not a full international phone number (country code first).')
    return d
  }

  const where = { auto: 'WhatsApp Desktop (WhatsApp Web in Chrome if it is unavailable)', desktop: 'WhatsApp Desktop', web: 'WhatsApp Web in Chrome' }

  return [
    defineTool({
      server: SERVER,
      name: 'whatsapp_open_chat',
      description:
        'Open WhatsApp on this PC at a chat with this number, with the message typed in but NOT sent: WhatsApp Desktop, or WhatsApp Web in Chrome ' +
        'when the app is not installed or will not start. The user presses send. Works with personal accounts. After the user approves the recipient and text. ' +
        'Use via "web" when the user says WhatsApp Desktop is logged out, stuck loading, or they want the browser.',
      input: {
        phone: recipient,
        text: z.string().max(2000).optional(),
        via: z.enum(['auto', 'desktop', 'web']).optional().describe('Default auto: Desktop, falling back to Web.'),
      },
      risk: RISK.COMMUNICATION,
      permissions: ['whatsapp:draft'],
      assess: (a) => (waNumber(a.phone) ? null : { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'is not a full international phone number' }),
      preview: (a) =>
        `Open ${where[a.via ?? 'auto']} at the chat with +${waNumber(a.phone)}${a.text ? `\nMessage, typed in for you to send:\n${a.text}` : ''}\nJARVIS does not press send.`,
      async run(args, { signal, progress }) {
        return wa.openChat(digitsOf(args.phone), args.text, { via: args.via, signal, progress })
      },
    }),

    defineTool({
      server: SERVER,
      name: 'whatsapp_share_location',
      description:
        "Prepare a WhatsApp message with a pinned location: either the paired phone's real position (needs its location permission), " +
        'or an address the user said. Opens the chat with the message typed in; the user presses send. Live location cannot be started this way.',
      input: {
        phone: recipient,
        source: z.enum(['phone', 'address']),
        address: z.string().min(3).max(300).optional(),
        note: z.string().max(300).optional(),
      },
      risk: RISK.COMMUNICATION,
      permissions: ['whatsapp:draft', 'phone:location'],
      assess(a) {
        if (!waNumber(a.phone)) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'is not a full international phone number' }
        if (a.source === 'address' && !a.address) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'needs the address the user gave' }
        return { verdict: 'confirm', risk: RISK.COMMUNICATION, reason: `shares a location with +${waNumber(a.phone)}` }
      },
      async preview(a, ctx) {
        const digits = waNumber(a.phone)
        if (a.source === 'address') return `To +${digits} (you press send):\n${a.note ? `${a.note}\n` : ''}${addressLink(a.address)}\n(address you gave, not a GPS position)`
        const fix = await wa.fixFor(`${digits}:${a.note ?? ''}`, ctx?.signal)
        return (
          `To +${digits} (you press send):\n${a.note ? `${a.note}\n` : ''}${mapsLink(fix)}\n` +
          `Phone position, accuracy ${fix.accuracy_m ?? '?'} m, fixed ${fix.age_minutes ?? '?'} min ago${fix.stale ? ' (STALE)' : ''}`
        )
      },
      async run(args, { signal, progress }) {
        const digits = digitsOf(args.phone)
        const report = await runSteps(
          [
            {
              id: 'locate',
              run: async () =>
                args.source === 'address'
                  ? { link: addressLink(args.address), kind: 'address' }
                  : { link: mapsLink(await wa.fixFor(`${digits}:${args.note ?? ''}`, signal)), kind: 'phone_fix', fix: await wa.fixFor(`${digits}:${args.note ?? ''}`, signal) },
            },
            { id: 'compose', deps: ['locate'], run: async ({ locate }) => `${args.note ? `${args.note}\n` : ''}${locate.link}` },
            { id: 'open', deps: ['compose'], run: async ({ compose }) => wa.openChat(digits, compose, { signal, progress }) },
          ],
          { signal },
        )
        wa.approvedFixes.delete(`${digits}:${args.note ?? ''}`)
        const locate = report.steps.find((s) => s.id === 'locate')
        if (!report.ok) {
          const failed = report.steps.find((s) => s.status === 'failed')
          throw new ToolError(failed?.error?.code ?? ERR.FAILED, failed?.error?.message ?? 'Could not prepare the location message.', { details: { steps: report.steps.map(({ id, status }) => ({ id, status })) } })
        }
        return {
          ...report.steps.find((s) => s.id === 'open').result,
          location: locate.result.kind === 'address' ? { kind: 'address', address: args.address } : { kind: 'phone_fix', ...locate.result.fix },
          link: locate.result.link,
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'whatsapp_prepare_on_phone',
      description:
        "Prepare a WhatsApp message ON THE USER'S PHONE (companion app over Wi-Fi): to a number or a contact name, optionally with the phone's " +
        'real location as a Maps link. Opens the chat with the text typed in, or posts a notification to tap if Android blocks opening it. ' +
        'It is NOT sent; the user presses send. Approved on the PC first, showing the exact recipient and message.',
      input: {
        phone: recipient.optional(),
        contact: z.string().min(1).max(80).optional(),
        text: z.string().max(2000).optional(),
        include_location: z.boolean().optional(),
        address: z.string().min(3).max(300).optional().describe('An address the user said, instead of the GPS position.'),
      },
      risk: RISK.COMMUNICATION,
      permissions: ['whatsapp:draft'],
      assess(a) {
        if (!a.phone === !a.contact) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'needs exactly one of phone or contact' }
        if (a.phone && !waNumber(a.phone)) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'is not a full international phone number' }
        if (!a.text && !a.include_location && !a.address) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'has no message to prepare' }
        return { verdict: 'confirm', risk: RISK.COMMUNICATION, reason: a.include_location || a.address ? 'shares a location in WhatsApp' : 'prepares a WhatsApp message' }
      },
      async preview(a) {
        const d = await wa.draftFor(a)
        return (
          `On your phone: WhatsApp to ${d.name ? `${d.name} ` : ''}+${d.digits} (you press send)\n${d.text}` +
          (d.fix ? `\nPhone position, accuracy ${d.fix.accuracy_m ?? '?'} m, ${d.fix.age_minutes ?? '?'} min old${d.fix.stale ? ' (STALE)' : ''}` : '') +
          (a.address ? '\n(address you gave, not a GPS position)' : '')
        )
      },
      async run(args, { signal }) {
        if (!wa.phone?.wifiConnected?.()) {
          throw new ToolError(ERR.NOT_CONNECTED, 'The phone is not connected over Wi-Fi. Use whatsapp_open_chat to prepare it on this PC instead.')
        }
        const d = await wa.draftFor(args, signal)
        wa.forgetDraft(args)
        // Not resent if the link drops: a second draft is harmless, but a
        // result we cannot vouch for is reported as unknown, not done.
        const r = await wa.phone.companion.request('whatsapp.prepare', { phone: d.digits, text: d.text }, { signal, idempotent: false })
        return {
          status: r?.status === 'opened' ? 'draft_opened_on_phone' : 'notification_posted',
          sent: false,
          to: `${d.name ? `${d.name} ` : ''}+${d.digits}`,
          ...(d.fix ? { location: d.fix } : {}),
          note:
            r?.status === 'opened'
              ? 'WhatsApp is open on the phone with the message typed in. It has NOT been sent; the user must press send.'
              : 'Android does not let a background app open WhatsApp, so a notification was posted on the phone. Tap it to open the chat, then press send. Nothing has been sent.',
        }
      },
    }),

    // Offered only with a business number configured: an approval for a send
    // that cannot run is an "allow" that does nothing.
    ...(wa.business() ? [defineTool({
      server: SERVER,
      name: 'whatsapp_send',
      description:
        'Send a text through the WhatsApp Business Platform (Cloud API), from the configured business number. ' +
        "Meta's rules apply (e.g. free-form text only within 24h of the recipient's last message). The user approves first. " +
        'The same text to the same number is not sent twice within two minutes.',
      input: { phone: recipient, text: z.string().min(1).max(4096) },
      risk: RISK.COMMUNICATION,
      permissions: ['whatsapp:send'],
      assess: (a) => (waNumber(a.phone) ? null : { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'is not a full international phone number' }),
      preview: (a) => `Send via WhatsApp Business to +${waNumber(a.phone)}:\n${a.text}`,
      async run(args, { signal, progress }) {
        progress('Sending through the WhatsApp Business API')
        const out = await wa.sendOnce(digitsOf(args.phone), args.text, signal)
        progress(out.duplicate ? `Already accepted earlier (${out.message_id}); not sent again` : `API confirmed: accepted (${out.message_id})`)
        return out
      },
    })] : []),

    defineTool({
      server: SERVER,
      name: 'whatsapp_delivery_status',
      description: 'Delivery status of a message sent with whatsapp_send, as reported by the WhatsApp webhook. Read only.',
      input: { message_id: z.string().min(4).max(200) },
      risk: RISK.READ,
      async run(args) {
        const s = wa.status(args.message_id)
        return s ?? { status: 'unknown', note: 'No delivery status has been received for this message. The webhook may not be set up, or it has not arrived yet.' }
      },
    }),
  ]
}
