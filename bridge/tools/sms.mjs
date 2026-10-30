/**
 * Text messages, through the paired phone's companion app over Wi-Fi.
 *
 * Three operations, each a different promise:
 *
 *   sms_draft   opens the phone's messages app with the text typed in.
 *               Nothing is sent; the person presses send. Needs no SMS
 *               permission on the phone.
 *   sms_send    sends from the phone with Android's SmsManager, after the
 *               exact recipient, number and full text are approved on the PC.
 *               The result is what the phone's radio reported: "sent" means
 *               the network accepted it; "delivered" is claimed only when the
 *               carrier's delivery report actually arrived.
 *   sms_recent  reads the latest texts, when the person has switched that on
 *               in the app. Text from other people is untrusted data.
 *
 * Emergency numbers and short codes (which include premium-rate services)
 * are refused here and again on the phone.
 */

import { z } from 'zod'
import { RISK } from '../policy.mjs'
import { defineTool, ToolError, ERR, untrusted } from './registry.mjs'
import { isEmergencyNumber, normaliseNumber, pickContact } from './android.mjs'

const SERVER = 'jarvis_phone'
export const MAX_SMS = 1000

/** Why this number must not be texted automatically, or null. */
export function smsRefusal(raw) {
  const n = normaliseNumber(raw)
  if (!n) return 'is not a valid phone number'
  if (isEmergencyNumber(n)) return 'would text an emergency number automatically'
  if (n.replace(/^\+/, '').length < 7) return 'would text a short code, which can be a premium-rate service'
  return null
}

/** @param {ReturnType<typeof import('../phone/companion.mjs').companionHub> | null} companion */
export function smsTools(companion) {
  /**
   * Recipient resolution, done once for the approval prompt and reused when
   * the call runs, so the number texted is the number the person approved
   * even if the contacts change in between.
   */
  const resolved = new Map()
  const keyOf = (a) => JSON.stringify([a.contact, a.number, a.text])

  const connected = () => {
    if (!companion?.connected()) {
      throw new ToolError(ERR.NOT_CONNECTED, 'The phone is not connected over Wi-Fi. Open the JARVIS companion app on it and check both are on the same Wi-Fi.')
    }
  }

  async function recipient(a, signal) {
    const key = keyOf(a)
    const held = resolved.get(key)
    if (held && Date.now() - held.at < 3 * 60_000) return held.who
    connected()
    let who
    if (a.number) {
      const n = normaliseNumber(a.number)
      if (!n) throw new ToolError(ERR.INVALID_ARGS, 'That is not a valid phone number.')
      who = { number: n, name: null }
    } else {
      const r = await companion.request('contacts.search', { query: a.contact }, { signal, idempotent: true })
      who = pickContact(r?.contacts ?? [], a.contact)
    }
    const why = smsRefusal(who.number)
    if (why) throw new ToolError(ERR.PERMISSION_DENIED, `Not texted: that ${why.replace(/^is /, 'is ').replace(/^would /, 'would ')}.`)
    resolved.set(key, { who, at: Date.now() })
    return who
  }

  const message = {
    contact: z.string().min(1).max(80).optional(),
    number: z.string().min(3).max(24).optional(),
    text: z.string().min(1).max(MAX_SMS),
  }
  const exactlyOne = (a) => (!a.contact === !a.number ? { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'needs exactly one of contact or number' } : null)
  const label = (who) => (who.name ? `${who.name} (${who.number})` : who.number)

  return [
    defineTool({
      server: SERVER,
      name: 'sms_send',
      description:
        'Send a text message (SMS) from the paired phone to a contact or number, e.g. "text Rahul that I am on my way". ' +
        'The user approves the exact recipient, number and full message on the PC first. Carrier SMS charges apply. ' +
        'Reports "sent" only when the phone confirms it, and "delivered" only if a delivery report arrives.',
      input: message,
      risk: RISK.COMMUNICATION,
      permissions: ['phone:sms_send'],
      assess(a) {
        const bad = exactlyOne(a)
        if (bad) return bad
        if (a.number) {
          const why = smsRefusal(a.number)
          if (why) return { verdict: 'deny', risk: RISK.HIGH, reason: why }
        }
        return { verdict: 'confirm', risk: RISK.COMMUNICATION, reason: 'sends a text message from your phone' }
      },
      async preview(a) {
        const who = await recipient(a)
        return `Text ${label(who)}\nFrom your phone, by SMS (carrier charges apply):\n\n${a.text}`
      },
      timeoutMs: 75_000,
      interruptedNote: 'If the phone had already started sending, the text may have gone. Check the Messages app before sending again.',
      async run(args, { signal }) {
        const who = await recipient(args, signal)
        resolved.delete(keyOf(args))
        let r
        try {
          // Never resent: a repeat after a dropped link would be a second text.
          r = await companion.request('sms.send', { number: who.number, text: args.text }, { signal, idempotent: false, timeoutMs: 70_000 })
        } catch (err) {
          if (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT || err.code === ERR.NOT_CONNECTED) {
            throw new ToolError(
              err.code,
              `${err.message} If the phone had already started sending, the text may have gone. Check the Messages app before sending again.`,
            )
          }
          throw err
        }
        const status = r?.status
        return {
          status: status === 'sent' ? 'sent' : 'handed_to_android',
          to: label(who),
          parts: r?.parts ?? null,
          delivered: status === 'sent' ? (r?.delivered === true ? true : 'unknown') : 'unknown',
          note:
            status === 'sent'
              ? r?.delivered === true
                ? 'The phone sent it and the carrier reported it delivered.'
                : 'The phone sent it to the mobile network. No delivery report has arrived (many carriers do not send one).'
              : 'Android accepted the message but has not confirmed it was sent. Check the Messages app.',
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'sms_draft',
      description:
        "Open the phone's messages app with a text typed in for a contact or number, without sending. The user presses send. " +
        'Use when the user asks to prepare or draft a text, or when sending is not allowed on the phone.',
      input: message,
      risk: RISK.REVERSIBLE,
      permissions: ['phone:sms_draft'],
      assess: (a) => exactlyOne(a),
      async run(args, { signal }) {
        const who = await recipient(args, signal)
        resolved.delete(keyOf(args))
        const r = await companion.request('sms.draft', { number: who.number, text: args.text }, { signal, idempotent: false })
        return {
          status: r?.status === 'opened' ? 'draft_opened' : 'notification_posted',
          sent: false,
          to: label(who),
          note:
            r?.status === 'opened'
              ? 'The messages app is open on the phone with the text typed in. It has NOT been sent; the user presses send.'
              : 'Android blocks a background app from opening screens, so a notification was posted on the phone. Tap it, then press send. Nothing has been sent.',
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'sms_recent',
      description:
        'The latest text messages on the phone, newest first, optionally only with one contact or number. Needs "Read recent texts" switched on in the companion app. Read only.',
      input: {
        contact: z.string().min(1).max(80).optional(),
        number: z.string().min(3).max(24).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      risk: RISK.READ,
      permissions: ['phone:sms_read'],
      async run(args, { signal }) {
        connected()
        let number
        if (args.contact) {
          const r = await companion.request('contacts.search', { query: args.contact }, { signal, idempotent: true })
          number = pickContact(r?.contacts ?? [], args.contact).number
        } else if (args.number) {
          number = normaliseNumber(args.number)
          if (!number) throw new ToolError(ERR.INVALID_ARGS, 'That is not a valid phone number.')
        }
        const r = await companion.request('sms.list', { limit: args.limit ?? 10, ...(number ? { number } : {}) }, { signal, idempotent: true })
        const list = r?.messages ?? []
        return { count: list.length, ...untrusted('text messages on the phone', JSON.stringify(list)) }
      },
    }),
  ]
}
