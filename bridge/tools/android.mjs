/**
 * The phone, over ADB.
 *
 * Why ADB and not a companion app: everything asked of the phone here —
 * status, the dialer, a call, contacts, notifications, location — is
 * reachable through Android's own debugging bridge once the owner has turned
 * on USB or wireless debugging and accepted this PC's key on the phone. That
 * is real, explicit, revocable pairing done by Android itself, it needs no
 * app to build, sign and sideload, and it cannot happen without the phone in
 * hand. A companion app would add push notifications and work away from the
 * PC's network; it is noted as future work rather than faked here.
 *
 * On top of Android's own pairing, JARVIS keeps its own list: a device the
 * PC can see is not one JARVIS may use until it is paired here too (with
 * approval), and location and notifications are each off per device until
 * the owner switches them on (with approval). Forgetting a device revokes
 * both and disconnects it.
 *
 * `adb shell` joins its arguments into a command line that the phone's shell
 * parses, so nothing a model or a contact name supplies is ever passed to it:
 * commands are fixed strings, phone numbers are validated to digits, and
 * searching contacts happens here, not on the phone.
 */

import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { RISK } from '../policy.mjs'
import { defineTool, ToolError, ERR, untrusted } from './registry.mjs'

const SERVER = 'jarvis_phone'

/**
 * Numbers JARVIS will never call on its own. Preparing the dialer for one is
 * allowed — the person then presses call themselves — but placing the call
 * is not, whatever was approved. Short codes are included because many
 * countries' emergency and crisis lines are three digits.
 */
const EMERGENCY = new Set(['911', '112', '999', '000', '110', '119', '118', '100', '101', '102', '108', '15', '17', '18', '061', '062', '063', '065', '1122', '115', '113', '911#'])

export function normaliseNumber(raw) {
  const s = String(raw).trim()
  const plus = s.startsWith('+')
  const digits = s.replace(/[\s().-]/g, '').replace(/^\+/, '')
  if (!/^\d{2,15}$/.test(digits)) return null
  return (plus ? '+' : '') + digits
}

export function isEmergencyNumber(num) {
  const digits = num.replace(/^\+/, '')
  return EMERGENCY.has(digits) || /^(1|9|0)\d{1,2}$/.test(digits)
}

/** `adb devices -l` → [{ serial, state, model }] */
export function parseDevices(out) {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/)
      const model = rest.find((r) => r.startsWith('model:'))?.slice(6).replace(/_/g, ' ') ?? null
      return { serial, state, model }
    })
}

/** `content query` rows → [{ name, number }] */
export function parseContacts(out) {
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const m = /display_name=(.*?), data1=(.*)$/.exec(line)
    if (m) rows.push({ name: m[1].trim(), number: m[2].trim() })
  }
  return rows
}

/** `+1d2h3m4s567ms` → milliseconds. */
export function parseElapsed(et) {
  let ms = 0
  for (const [, n, unit] of et.matchAll(/(\d+)(ms|d|h|m|s)/g)) {
    ms += Number(n) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3, ms: 1 }[unit]
  }
  return ms
}

/**
 * The freshest fix in `dumpsys location`, with how old it is. Android prints
 * the fix's age as elapsed-realtime since boot, so it needs the phone's
 * uptime to become a timestamp.
 */
export function parseLocation(dump, uptimeSeconds, now = Date.now()) {
  const fixes = []
  const re = /Location\[(\w+)\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)([^\]]*)\]/g
  let m
  while ((m = re.exec(dump))) {
    const rest = m[4]
    const acc = /hAcc=([\d.]+)/.exec(rest)?.[1] ?? /acc=([\d.]+)/.exec(rest)?.[1]
    const et = /et=\+?([\dmsdh]+)/.exec(rest)?.[1]
    const ageMs = et != null && uptimeSeconds != null ? Math.max(0, uptimeSeconds * 1000 - parseElapsed(et)) : null
    fixes.push({ provider: m[1], latitude: Number(m[2]), longitude: Number(m[3]), accuracy_m: acc ? Number(acc) : null, ageMs })
  }
  if (!fixes.length) return null
  fixes.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity))
  const best = fixes[0]
  return {
    ...best,
    fixed_at: best.ageMs != null ? new Date(now - best.ageMs).toISOString() : null,
    age_minutes: best.ageMs != null ? +(best.ageMs / 6e4).toFixed(1) : null,
    stale: best.ageMs == null || best.ageMs > 15 * 6e4,
  }
}

/** Notification titles and text out of `dumpsys notification --noredact`. */
export function parseNotifications(dump, limit = 15) {
  const out = []
  const blocks = dump.split(/NotificationRecord\(/).slice(1)
  for (const b of blocks) {
    const pkg = /pkg=([\w.]+)/.exec(b)?.[1]
    const title = /android\.title=\w+ \((.*?)\)\s*$/m.exec(b)?.[1]
    const text = /android\.text=\w+ \((.*?)\)\s*$/m.exec(b)?.[1]
    if (pkg && (title || text)) out.push({ app: pkg, title: title ?? '', text: text ?? '' })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Exactly one contact for a spoken name: an exact match wins, otherwise a
 * partial one, and two different numbers are a question for the person, not a
 * coin toss. The same rule whether the contacts came over USB or Wi-Fi.
 */
export function pickContact(rows, query) {
  const q = query.toLowerCase()
  const exact = rows.filter((r) => r.name.toLowerCase() === q)
  const hits = exact.length ? exact : rows.filter((r) => r.name.toLowerCase().includes(q))
  const distinct = [...new Map(hits.map((h) => [normaliseNumber(h.number), h])).values()].filter((h) => normaliseNumber(h.number))
  if (!distinct.length) throw new ToolError(ERR.NOT_FOUND, `No contact matching "${query}".`)
  if (distinct.length > 1) {
    throw new ToolError(ERR.AMBIGUOUS, `Several contacts match "${query}". Ask which one.`, {
      details: { candidates: distinct.slice(0, 8).map((h) => ({ name: h.name, number: h.number })) },
    })
  }
  return { number: normaliseNumber(distinct[0].number), name: distinct[0].name }
}

/** A location as the companion app reports it, in the same shape as the ADB one. */
export function companionFix(r) {
  const ageMs = r.age_seconds != null ? r.age_seconds * 1000 : null
  return {
    source: 'paired phone over Wi-Fi',
    provider: r.provider ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy_m: r.accuracy_m ?? null,
    fixed_at: r.fixed_at ?? null,
    age_minutes: ageMs != null ? +(ageMs / 6e4).toFixed(1) : null,
    stale: r.stale ?? (ageMs == null || ageMs > 15 * 6e4),
    fresh_fix: Boolean(r.fresh),
  }
}

/**
 * @param {{ run: typeof import('./exec.mjs').run, adb?: string, stateFile: string }} opts
 */
export function androidConnector({ run, adb = process.env.JARVIS_ADB || 'adb', stateFile }) {
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch {
      return { devices: {} }
    }
  }
  const save = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 })
  }

  const adbRun = (args, signal, timeoutMs = 15_000) => run(adb, args, { signal, timeoutMs })

  async function devices(signal) {
    const { stdout } = await adbRun(['devices', '-l'], signal)
    const paired = load().devices
    return parseDevices(stdout).map((d) => ({
      ...d,
      paired: Boolean(paired[d.serial]),
      permissions: paired[d.serial]?.permissions ?? { location: false, notifications: false },
    }))
  }

  /** The device a command may go to, or a precise reason why there is none. */
  async function target(serial, signal) {
    const list = await devices(signal)
    const paired = list.filter((d) => d.paired)
    const pick = serial ? list.find((d) => d.serial === serial) : paired.find((d) => d.state === 'device') ?? paired[0]
    if (!pick) {
      const known = Object.keys(load().devices)
      if (serial || known.length) throw new ToolError(ERR.NOT_CONNECTED, `The paired phone${serial ? ` ${serial}` : ''} is not connected. Check the USB cable or wireless debugging.`)
      throw new ToolError(ERR.NOT_CONNECTED, 'No phone is paired. Connect one with USB debugging on, then pair it.')
    }
    if (pick.state === 'unauthorized') throw new ToolError(ERR.PERMISSION_DENIED, 'The phone has not accepted this PC. Unlock it and allow USB debugging.')
    if (pick.state !== 'device') throw new ToolError(ERR.NOT_CONNECTED, `The phone is ${pick.state}.`)
    if (!pick.paired) throw new ToolError(ERR.UNAUTHORIZED, `Phone ${pick.serial} is connected but not paired with JARVIS. Pair it first.`)
    return pick
  }

  const shell = (serial, command, signal, timeoutMs) => adbRun(['-s', serial, 'shell', command], signal, timeoutMs)

  function setPermission(serial, capability, enabled) {
    const s = load()
    if (!s.devices[serial]) throw new ToolError(ERR.UNAUTHORIZED, `Phone ${serial} is not paired.`)
    s.devices[serial].permissions = { location: false, notifications: false, ...s.devices[serial].permissions, [capability]: enabled }
    save(s)
    return s.devices[serial].permissions
  }

  async function location(serial, signal) {
    const dev = await target(serial, signal)
    if (!dev.permissions.location) {
      throw new ToolError(ERR.PERMISSION_DENIED, 'Phone location is switched off for JARVIS. The user can allow it with phone_permission.')
    }
    const mode = (await shell(dev.serial, 'settings get secure location_mode', signal)).stdout.trim()
    if (mode === '0') throw new ToolError(ERR.PERMISSION_DENIED, 'Location is turned off on the phone itself.')
    const [{ stdout: dump }, { stdout: up }] = await Promise.all([
      shell(dev.serial, 'dumpsys location', signal, 20_000),
      shell(dev.serial, 'cat /proc/uptime', signal),
    ])
    const fix = parseLocation(dump, Number(up.trim().split(/\s+/)[0]))
    if (!fix) throw new ToolError(ERR.NOT_FOUND, 'The phone has no recent location fix. Open a maps app on it to get one.')
    return { device: dev.serial, source: 'paired phone (last known fix)', ...fix }
  }

  async function contacts(serial, signal) {
    const dev = await target(serial, signal)
    const { stdout } = await shell(dev.serial, 'content query --uri content://com.android.contacts/data/phones --projection display_name:data1', signal, 20_000)
    return { dev, rows: parseContacts(stdout) }
  }

  /** A number, or exactly one contact's number; never a guess. */
  async function resolveCallee(args, signal) {
    if (args.number) {
      const n = normaliseNumber(args.number)
      if (!n) throw new ToolError(ERR.INVALID_ARGS, 'That is not a valid phone number.')
      return { number: n, name: null }
    }
    const { rows } = await contacts(args.serial, signal)
    return pickContact(rows, args.contact)
  }

  return { devices, target, location, contacts, resolveCallee, setPermission, load, save, adbRun, shell }
}

/**
 * The phone tools. Each works over whichever link is up: the companion app
 * over Wi-Fi when it is connected (preferred — no cable), otherwise ADB.
 * Either way the call has already passed the same policy hook and approval;
 * the link only decides how the request reaches the phone.
 *
 * @param {ReturnType<typeof androidConnector>} phone
 * @param {ReturnType<typeof import('../phone/companion.mjs').companionHub> | null} [companion]
 */
export function androidTools(phone, companion = null) {
  const serial = z.string().min(1).max(64).regex(/^[\w.:-]+$/).optional().describe('USB only: needed with more than one phone.')
  const callee = {
    number: z.string().min(2).max(24).optional(),
    contact: z.string().min(1).max(80).optional(),
    serial,
  }
  const needOne = (args) => {
    if (!args.number === !args.contact) throw new ToolError(ERR.INVALID_ARGS, 'Give either a number or a contact name.')
  }
  /**
   * Wi-Fi whenever the companion is connected. A serial number in the
   * arguments does not override it: the model remembers a USB serial from an
   * earlier cable session and passes it along, and treating that as "use the
   * cable" sent calls down an unplugged USB route while a working Wi-Fi link
   * sat idle.
   */
  const wifi = () => Boolean(companion?.connected())

  async function resolveWifi(args, signal) {
    if (args.number) {
      const n = normaliseNumber(args.number)
      if (!n) throw new ToolError(ERR.INVALID_ARGS, 'That is not a valid phone number.')
      return { number: n, name: null }
    }
    const r = await companion.request('contacts.search', { query: args.contact }, { signal, idempotent: true })
    return pickContact(r?.contacts ?? [], args.contact)
  }
  const resolve = (args, signal) => (wifi(args) ? resolveWifi(args, signal) : phone.resolveCallee(args, signal))

  const deviceId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional().describe('Only needed with more than one paired phone.')
  const onlyDevice = (id) => {
    const list = companion?.status().devices ?? []
    const dev = id ? list.find((d) => d.id === id) : list.length === 1 ? list[0] : null
    if (!dev) throw new ToolError(list.length ? ERR.AMBIGUOUS : ERR.NOT_FOUND, list.length ? 'Say which phone (device_id from phone_status).' : 'No phone is paired over Wi-Fi.', { details: { devices: list.map((d) => ({ id: d.id, name: d.name })) } })
    return dev
  }
  const needCompanion = () => {
    if (!companion) throw new ToolError(ERR.NOT_CONFIGURED, 'The Wi-Fi companion link is not available in this build.')
  }

  return [
    defineTool({
      server: SERVER,
      name: 'phone_status',
      description:
        'The phone links: the companion app over Wi-Fi (paired? connected right now? battery, permissions) and phones on USB/ADB. Read only.',
      input: {},
      risk: RISK.READ,
      async run(_args, { signal }) {
        const wifiStatus = companion ? companion.status() : null
        let usb
        try {
          usb = { devices: await phone.devices(signal) }
        } catch (err) {
          usb = { error: err.message }
        }
        return {
          wifi: wifiStatus ?? { note: 'not available' },
          usb,
          active_link: wifi() ? 'wifi' : usb.devices?.some((d) => d.paired && d.state === 'device') ? 'usb' : 'none',
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_wifi_pair',
      description:
        'Start pairing a phone over Wi-Fi with the JARVIS companion app. Shows a QR code in the JARVIS console for the user to scan in the app; ' +
        'the user then approves the pairing on both screens. Returns at once; pairing completes when they do.',
      input: {},
      risk: RISK.REVERSIBLE,
      permissions: ['phone:pair'],
      async run() {
        needCompanion()
        const p = await companion.startPairing()
        return {
          status: 'waiting_for_phone',
          expires_at: p.expiresAt,
          listening_on: p.hosts.map((h) => `${h}:${p.port}`),
          note: 'The QR code is on the PC screen (console → connections). Open the JARVIS companion app, tap Pair and scan it, then approve on both devices. Nothing is paired yet.',
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_wifi_disconnect',
      description: 'Disconnect the Wi-Fi phone and keep it disconnected until the user reconnects it. Its pairing is kept.',
      input: { device_id: deviceId },
      risk: RISK.REVERSIBLE,
      async run(args) {
        needCompanion()
        const dev = onlyDevice(args.device_id)
        companion.pause(dev.id, true)
        return { disconnected: dev.name, paired: true }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_wifi_reconnect',
      description: 'Allow a disconnected Wi-Fi phone to connect again. The app reconnects by itself within a minute.',
      input: { device_id: deviceId },
      risk: RISK.REVERSIBLE,
      async run(args) {
        needCompanion()
        const dev = onlyDevice(args.device_id)
        companion.pause(dev.id, false)
        return { allowed: dev.name, connected: companion.connected(dev.id), note: companion.connected(dev.id) ? undefined : 'Waiting for the app to reconnect.' }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_wifi_revoke',
      description: "Unpair a Wi-Fi phone completely: its key is deleted here and the app is told to forget this PC. It must be paired again to use.",
      input: { device_id: deviceId },
      risk: RISK.REVERSIBLE,
      async run(args) {
        needCompanion()
        const dev = onlyDevice(args.device_id)
        await companion.revoke(dev.id)
        return { revoked: dev.name }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_pair',
      description:
        'USB/ADB pairing (the cable route). Either a phone already connected over USB (serial from phone_status), or Android wireless debugging ' +
        '(host, pair_port and the 6-digit code shown on the phone, plus connect_port). For the companion app use phone_wifi_pair. The user approves it first.',
      input: {
        serial,
        host: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/).optional(),
        pair_port: z.number().int().min(1).max(65535).optional(),
        connect_port: z.number().int().min(1).max(65535).optional(),
        code: z.string().regex(/^\d{6}$/).optional(),
      },
      risk: RISK.HIGH,
      permissions: ['phone:pair'],
      preview: (a) => (a.host ? `Pair phone at ${a.host} (wireless debugging) with JARVIS` : `Pair phone ${a.serial ?? '(the connected one)'} with JARVIS over USB`),
      async run(args, { signal }) {
        let serialToPair = args.serial
        if (args.host) {
          if (!args.pair_port || !args.code || !args.connect_port) {
            throw new ToolError(ERR.INVALID_ARGS, 'Wireless pairing needs host, pair_port, code and connect_port from the phone screen.')
          }
          const p = await phone.adbRun(['pair', `${args.host}:${args.pair_port}`, args.code], signal, 30_000)
          if (!/Successfully paired/i.test(p.stdout + p.stderr)) {
            throw new ToolError(ERR.PERMISSION_DENIED, `The phone refused pairing: ${(p.stdout + p.stderr).trim().slice(0, 200)}`)
          }
          serialToPair = `${args.host}:${args.connect_port}`
          const c = await phone.adbRun(['connect', serialToPair], signal, 20_000)
          if (!/connected to/i.test(c.stdout)) throw new ToolError(ERR.NOT_CONNECTED, `Paired, but could not connect: ${c.stdout.trim().slice(0, 200)}`)
        }
        const list = await phone.devices(signal)
        const dev = serialToPair ? list.find((d) => d.serial === serialToPair) : list.find((d) => d.state === 'device')
        if (!dev) throw new ToolError(ERR.NOT_CONNECTED, 'No connected phone to pair.')
        if (dev.state === 'unauthorized') throw new ToolError(ERR.PERMISSION_DENIED, 'Accept the USB debugging prompt on the phone, then try again.')
        if (dev.state !== 'device') throw new ToolError(ERR.NOT_CONNECTED, `The phone is ${dev.state}.`)
        const s = phone.load()
        s.devices[dev.serial] = { model: dev.model, pairedAt: new Date().toISOString(), permissions: { location: false, notifications: false } }
        phone.save(s)
        return { paired: dev.serial, model: dev.model, permissions: s.devices[dev.serial].permissions }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_forget',
      description: 'Unpair a USB/ADB phone: revokes its location and notification access and disconnects wireless debugging.',
      input: { serial: z.string().min(1).max(64).regex(/^[\w.:-]+$/) },
      risk: RISK.REVERSIBLE,
      async run(args, { signal }) {
        const s = phone.load()
        const was = Boolean(s.devices[args.serial])
        delete s.devices[args.serial]
        phone.save(s)
        if (args.serial.includes(':')) await phone.adbRun(['disconnect', args.serial], signal).catch(() => {})
        return { forgotten: args.serial, was_paired: was }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_permission',
      description:
        "USB/ADB only: allow or revoke JARVIS reading the phone's location or notifications. With the companion app these are switched in the app itself. " +
        'Allowing needs the user’s approval; revoking does not.',
      input: { capability: z.enum(['location', 'notifications']), enabled: z.boolean(), serial },
      risk: RISK.REVERSIBLE,
      assess: (a) =>
        a.enabled
          ? { verdict: 'confirm', risk: RISK.HIGH, reason: `lets JARVIS read the phone's ${a.capability}`, summary: `Allow JARVIS to read ${a.capability} from your phone` }
          : null,
      async run(args, { signal }) {
        if (wifi(args)) {
          throw new ToolError(ERR.UNSUPPORTED, `With the companion app, ${args.capability} access is switched on or off in the app on the phone (Permissions).`)
        }
        const dev = await phone.target(args.serial, signal)
        return { device: dev.serial, permissions: phone.setPermission(dev.serial, args.capability, args.enabled) }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_contacts',
      description: 'Search contacts on the phone by name. Read only.',
      input: { query: z.string().min(1).max(80), serial },
      risk: RISK.READ,
      permissions: ['phone:contacts'],
      async run(args, { signal }) {
        if (wifi(args)) {
          const r = await companion.request('contacts.search', { query: args.query }, { signal, idempotent: true })
          return { link: 'wifi', matches: (r?.contacts ?? []).slice(0, 20) }
        }
        const { rows } = await phone.contacts(args.serial, signal)
        const q = args.query.toLowerCase()
        return { link: 'usb', matches: rows.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 20) }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_dial',
      description:
        "Open the phone's dialer with a number filled in, without calling. The user presses call. Works for any number, including emergency numbers.",
      input: callee,
      risk: RISK.REVERSIBLE,
      permissions: ['phone:dialer'],
      async run(args, { signal }) {
        needOne(args)
        const who = await resolve(args, signal)
        if (wifi(args)) {
          const r = await companion.request('call.dial', { number: who.number }, { signal })
          return {
            status: r?.status === 'opened' ? 'prepared' : 'notification_posted',
            number: who.number,
            contact: who.name,
            note:
              r?.status === 'opened'
                ? 'The dialer is open on the phone. Nothing has been called.'
                : 'Android does not let a background app open the dialer, so a notification was posted on the phone: tap it to open the dialer. Nothing has been called.',
          }
        }
        const dev = await phone.target(args.serial, signal)
        const { stdout, stderr } = await phone.shell(dev.serial, `am start -a android.intent.action.DIAL -d tel:${who.number}`, signal)
        if (/Error|Exception/.test(stdout + stderr)) throw new ToolError(ERR.FAILED, 'The phone would not open the dialer.')
        return { status: 'prepared', number: who.number, contact: who.name, note: 'Dialer is open on the phone. Nothing has been called.' }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_call',
      description:
        'Place a call from the phone to a number or a single unambiguous contact, after the user approves it on screen. ' +
        'Emergency numbers are never called automatically; use phone_dial for those.',
      input: callee,
      risk: RISK.COMMUNICATION,
      permissions: ['phone:call'],
      async assess(args) {
        if (!args.number === !args.contact) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'needs exactly one of number or contact' }
        if (args.number) {
          const n = normaliseNumber(args.number)
          if (!n) return { verdict: 'deny', risk: RISK.COMMUNICATION, reason: 'is not a valid phone number' }
          if (isEmergencyNumber(n)) return { verdict: 'deny', risk: RISK.HIGH, reason: 'would call an emergency or short-code number automatically' }
        }
        return null
      },
      async preview(args) {
        return `Call ${args.contact ? `${args.contact} (the number is looked up on the phone)` : normaliseNumber(args.number)}`
      },
      async run(args, { signal }) {
        needOne(args)
        const who = await resolve(args, signal)
        // Checked again after resolving: a contact can be saved as "Police".
        if (isEmergencyNumber(who.number)) {
          throw new ToolError(ERR.PERMISSION_DENIED, 'That resolves to an emergency or short-code number, which JARVIS never calls. Use phone_dial so the user can call it.')
        }
        if (wifi(args)) {
          // Never resent after a dropped link: a repeat would be a second call.
          const r = await companion.request('call.place', { number: who.number }, { signal, idempotent: false })
          return {
            status: r?.status === 'dialing' ? 'initiated' : 'requested',
            number: who.number,
            contact: who.name,
            link: 'wifi',
            note:
              r?.status === 'dialing'
                ? 'The phone has started the call. Whether it was answered is not known.'
                : 'The phone was asked to place the call. Whether it connected is not known.',
          }
        }
        const dev = await phone.target(args.serial, signal)
        const { stdout, stderr } = await phone.shell(dev.serial, `am start -a android.intent.action.CALL -d tel:${who.number}`, signal)
        if (/Error|Exception|SecurityException/.test(stdout + stderr)) {
          throw new ToolError(ERR.PERMISSION_DENIED, 'The phone refused to start the call. Use phone_dial instead and press call on the phone.')
        }
        // Whether it actually went off-hook, read back rather than assumed.
        await new Promise((r) => setTimeout(r, 2500))
        const reg = await phone.shell(dev.serial, 'dumpsys telephony.registry', signal).catch(() => ({ stdout: '' }))
        const offhook = /mCallState=2/.test(reg.stdout)
        return {
          status: offhook ? 'initiated' : 'requested',
          number: who.number,
          contact: who.name,
          link: 'usb',
          note: offhook
            ? 'The phone is now on a call (dialling or connected). Whether it was answered is not known.'
            : 'The call request was sent but the phone has not gone off-hook. It may be waiting for confirmation on screen.',
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_location',
      description:
        "The phone's location with accuracy, timestamp and whether it is stale. Over Wi-Fi it asks the phone for a fresh fix (the app's location " +
        'permission must be on); over USB it reads the last known fix (needs phone_permission). This is the phone, not this PC.',
      input: { serial, fresh: z.boolean().optional() },
      risk: RISK.READ,
      permissions: ['phone:location'],
      async run(args, { signal }) {
        if (wifi(args)) {
          return companionFix(await companion.request('location.get', { fresh: args.fresh ?? true }, { signal, idempotent: true, timeoutMs: 30_000 }))
        }
        return await phone.location(args.serial, signal)
      },
    }),

    defineTool({
      server: SERVER,
      name: 'phone_notifications',
      description:
        "Current notifications on the phone (only those Android shows right now; no history). Over Wi-Fi the app's notification access must be on.",
      input: { serial, limit: z.number().int().min(1).max(50).optional() },
      risk: RISK.READ,
      permissions: ['phone:notifications'],
      async run(args, { signal }) {
        if (wifi(args)) {
          const r = await companion.request('notifications.list', { limit: args.limit ?? 15 }, { signal, idempotent: true })
          const list = r?.notifications ?? []
          return { link: 'wifi', count: list.length, ...untrusted('phone notifications', JSON.stringify(list)) }
        }
        const dev = await phone.target(args.serial, signal)
        if (!dev.permissions.notifications) {
          throw new ToolError(ERR.PERMISSION_DENIED, 'Reading phone notifications is switched off for JARVIS. The user can allow it with phone_permission.')
        }
        const { stdout } = await phone.shell(dev.serial, 'dumpsys notification --noredact', signal, 20_000)
        const list = parseNotifications(stdout, args.limit ?? 15)
        return { link: 'usb', device: dev.serial, count: list.length, ...untrusted('phone notifications', JSON.stringify(list)) }
      },
    }),
  ]
}

/**
 * The USB route switched off (JARVIS_PHONE_LINK=wifi): every ADB path reports
 * the Wi-Fi link's state instead of touching adb at all.
 */
export function wifiOnly(phone) {
  const refuse = async () => {
    throw new ToolError(
      ERR.NOT_CONNECTED,
      'The phone is not connected over Wi-Fi (USB is switched off for JARVIS). Open the JARVIS companion app on the phone and check both are on the same Wi-Fi.',
    )
  }
  return {
    ...phone,
    devices: async () => [],
    target: refuse,
    location: refuse,
    contacts: refuse,
    resolveCallee: refuse,
    shell: refuse,
    adbRun: refuse,
    usbDisabled: true,
  }
}

/**
 * The phone as the rest of JARVIS sees it (WhatsApp's location sharing, for
 * one): the Wi-Fi app when connected, otherwise ADB.
 */
export function phoneRouter(phone, companion) {
  return {
    async location(serial, signal) {
      if (!serial && companion?.connected()) {
        return companionFix(await companion.request('location.get', { fresh: true }, { signal, idempotent: true, timeoutMs: 30_000 }))
      }
      return phone.location(serial, signal)
    },
    async resolveContact(name, signal) {
      if (companion?.connected()) {
        const r = await companion.request('contacts.search', { query: name }, { signal, idempotent: true })
        return pickContact(r?.contacts ?? [], name)
      }
      return phone.resolveCallee({ contact: name }, signal)
    },
    wifiConnected: () => Boolean(companion?.connected()),
    companion,
  }
}
