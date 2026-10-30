/**
 * JARVIS's own integrations, assembled in one place: the tool registry the
 * agent sees, and the handful of HTTP routes the console uses to show status,
 * review memory and connect or disconnect accounts.
 *
 * server.mjs owns the agent and the policy hook; this owns what the tools are
 * and what state they keep. Nothing here decides whether a tool may run —
 * that is the hook's job, through Registry.authorize().
 */

import { join } from 'node:path'
import { Registry } from './tools/registry.mjs'
import { run } from './tools/exec.mjs'
import { desktopTools, systemStats } from './tools/desktop.mjs'
import { androidConnector, androidTools, phoneRouter, wifiOnly } from './tools/android.mjs'
import { companionHub } from './phone/companion.mjs'
import { smsTools } from './tools/sms.mjs'
import QRCode from 'qrcode'
import { whatsappConnector, whatsappTools } from './tools/whatsapp.mjs'
import { windowsWhatsApp } from './tools/whatsapp-desktop.mjs'
import { googleConnector, googleTools } from './tools/google.mjs'
import { homeAssistant, homeTools } from './tools/homeassistant.mjs'
import { memoryStore, memoryTools } from './tools/memory.mjs'
import { secretStore } from './tools/secrets.mjs'
import { identityStore, IDENTITY_ROUTES, IDENTITY_MAX_BODY } from './identity.mjs'
import { statfs } from 'node:fs/promises'

const MAX_BODY = 64 * 1024

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const page = (title, message) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  '<body style="font:16px system-ui;background:#05080c;color:#cfe8ff;display:grid;place-items:center;height:100vh;margin:0">' +
  `<div style="max-width:32rem;text-align:center"><h1 style="font-weight:500;letter-spacing:.1em">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`

/** Run a status probe, but never let a slow device or server hold the console up. */
const within = (ms, p, fallback) => Promise.race([p.catch((e) => ({ ...fallback, error: e.message })), new Promise((r) => setTimeout(() => r({ ...fallback, error: 'timed out' }), ms))])

/**
 * @param {{ audit: (e: object) => void, backup: (f: string) => string|null,
 *           ctx: object, port: number, stateDir: string,
 *           info: () => Promise<object>|object, originAllowed: (o: string) => boolean }} opts
 */
export function createIntegrations({ audit, backup, ctx, port, stateDir, info, originAllowed }) {
  const secrets = secretStore({ dir: join(stateDir, 'secrets'), run })
  // Face and voice templates, and the PIN. Shares the encrypted secret store.
  const identity = identityStore({ secrets, audit })
  const memory = memoryStore({ dir: stateDir, persistDefault: process.env.JARVIS_MEMORY !== 'off' })
  memory.prune()
  // JARVIS_PHONE_LINK=wifi: the phone is reached only through the companion
  // app; adb is never run for it.
  const usbPhone = androidConnector({ run, stateFile: join(stateDir, 'android.json') })
  const phone = process.env.JARVIS_PHONE_LINK === 'wifi' ? wifiOnly(usbPhone) : usbPhone
  // The companion app over Wi-Fi. Listens only once a phone is paired or a
  // pairing is started, and only on this PC's private-network addresses.
  const companion = companionHub({ secrets, stateFile: join(stateDir, 'companion.json'), audit })
  void companion.autostart()
  const phoneLink = phoneRouter(phone, companion)
  const whatsapp = whatsappConnector({ desktop: windowsWhatsApp({ run }), phone: phoneLink, audit })
  const google = googleConnector({ secrets, redirectUri: `http://127.0.0.1:${port}/oauth/google/callback` })
  const home = homeAssistant()
  const docsDirs = (process.env.JARVIS_DOCS_DIR ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  const registry = new Registry({ audit, ctx }).add(
    desktopTools({ run, backup, stateDir }),
    memoryTools(memory, { docsDirs }),
    androidTools(phone, companion),
    smsTools(companion),
    whatsappTools(whatsapp),
    googleTools(google),
    homeTools(home),
  )

  let homeCache = { at: 0, value: null }

  async function status() {
    const phoneStatus = within(4000, phone.devices().then((devices) => ({ adb: true, devices })), { adb: false, devices: [] })
    if (Date.now() - homeCache.at > 30_000) homeCache = { at: Date.now(), value: within(5000, home.status(), { configured: home.configured(), connected: false }) }
    const disks = []
    for (const root of new Set((ctx.readRoots ?? ctx.roots).map((r) => (process.platform === 'win32' ? `${r.slice(0, 2).toUpperCase()}\\` : '/')))) {
      try {
        const s = await statfs(root)
        disks.push({ drive: root, free_gb: +((s.bavail * s.bsize) / 1e9).toFixed(1), total_gb: +((s.blocks * s.bsize) / 1e9).toFixed(1) })
      } catch {
        /* not mounted */
      }
    }
    const settings = memory.settings()
    return {
      ...(await info()),
      tools: registry.list().length,
      system: { ...(await systemStats(250)), disks },
      integrations: {
        google: await within(15_000, google.status(), { configured: google.configured(), connected: false }),
        whatsapp: { personal_links: true, business_api: Boolean(whatsapp.business()) },
        phone: await phoneStatus,
        phone_wifi: companion.status(),
        home: await homeCache.value,
        memory: { ...settings, items: memory.list().length, docs_folders: docsDirs.length },
        secrets: { encrypted_at_rest: secrets.encrypted },
      },
    }
  }

  /**
   * The console's routes. Anything that changes or reveals stored state must
   * come from a page this bridge already trusts: a request with no Origin at
   * all (another program on this PC, or a link opened elsewhere) is refused
   * here even though the general origin check lets it through.
   *
   * @returns {Promise<boolean>} whether the request was handled
   */
  async function handle(req, res, cors) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...cors, 'content-type': type, 'cache-control': 'no-store' })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
      return true
    }
    const fromConsole = () => Boolean(req.headers.origin) && originAllowed(req.headers.origin)

    // Meta calls this directly, with no Origin; it authenticates by signature.
    if (p === '/whatsapp/webhook') {
      const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
      const r = whatsapp.webhook(req.method, url.searchParams, raw, req.headers)
      return send(r.status, r.body, 'text/plain')
    }

    // Google redirects the browser here: a top-level navigation, no Origin.
    if (p === '/oauth/google/start' && req.method === 'GET') {
      try {
        res.writeHead(302, { location: google.authUrl(), 'cache-control': 'no-store' })
        res.end()
        return true
      } catch (err) {
        return send(400, page('Google not set up', err.message), 'text/html; charset=utf-8')
      }
    }
    if (p === '/oauth/google/callback' && req.method === 'GET') {
      const r = await google.handleCallback(url.searchParams)
      audit({ event: 'integration', integration: 'google', action: 'connect', ok: r.ok })
      return send(r.ok ? 200 : 400, page(r.ok ? 'Google connected' : 'Google not connected', r.message), 'text/html; charset=utf-8')
    }

    const consoleRoutes = [
      '/status', '/tools', '/memory', '/memory/settings', '/memory/item', '/memory/export', '/oauth/google/disconnect', '/phone/revoke',
      '/phone/wifi', '/phone/wifi/pair', '/phone/wifi/pairing', '/phone/wifi/cancel', '/phone/wifi/disconnect', '/phone/wifi/reconnect', '/phone/wifi/revoke',
      ...IDENTITY_ROUTES,
    ]
    if (!consoleRoutes.includes(p)) return false
    if (!fromConsole()) return send(403, { error: 'This endpoint only answers the JARVIS console.' })

    if (p === '/status' && req.method === 'GET') return send(200, await status())

    // ---- identity: face, voice, PIN ----------------------------------------
    if (p === '/identity' && req.method === 'GET') return send(200, await identity.status())
    if (IDENTITY_ROUTES.includes(p) && req.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(req, IDENTITY_MAX_BODY)).toString('utf8'))
      } catch {
        return send(400, { error: 'bad json' })
      }
      const action = {
        '/identity/enroll': identity.enroll,
        '/identity/verify': identity.verify,
        '/identity/pin/verify': identity.verifyPin,
        '/identity/pin': identity.changePin,
        '/identity/profile': identity.updateProfile,
        '/identity/forget': identity.forget,
      }[p]
      if (!action) return send(405, { error: 'method not allowed' })
      const r = await action(body ?? {})
      return send(r.status, r.body)
    }
    if (p === '/tools' && req.method === 'GET') return send(200, registry.list())

    if (p === '/memory' && req.method === 'GET') {
      return send(200, { settings: memory.settings(), items: memory.list(), history: memory.history(50).reverse() })
    }
    if (p === '/memory' && req.method === 'DELETE') {
      memory.clear()
      audit({ event: 'memory', action: 'clear_all' })
      return send(200, { cleared: true })
    }
    if (p === '/memory/item' && req.method === 'DELETE') {
      const ok = memory.remove(url.searchParams.get('id') ?? '')
      audit({ event: 'memory', action: 'delete', ok })
      return send(ok ? 200 : 404, { deleted: ok })
    }
    if (p === '/memory/settings' && req.method === 'PUT') {
      let body
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        return send(400, { error: 'bad json' })
      }
      const next = memory.setSettings(body)
      audit({ event: 'memory', action: 'settings', ...next })
      return send(200, next)
    }
    if (p === '/memory/export' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'content-disposition': 'attachment; filename="jarvis-memory.json"', 'cache-control': 'no-store' })
      res.end(JSON.stringify(memory.exportAll(), null, 2))
      return true
    }
    if (p === '/oauth/google/disconnect' && req.method === 'POST') {
      const r = await google.disconnect()
      audit({ event: 'integration', integration: 'google', action: 'disconnect', revoked: r.revoked_at_google })
      return send(200, r)
    }
    // ---- the Wi-Fi companion ------------------------------------------------
    if (p === '/phone/wifi' && req.method === 'GET') return send(200, companion.status())
    if (p === '/phone/wifi/pairing' && req.method === 'GET') {
      // The QR code, drawn here so the one-time secret never leaves the PC
      // except as pixels on its own screen.
      const cur = companion.pairingUri()
      if (!cur) return send(200, { active: false })
      return send(200, { active: true, expiresAt: cur.expiresAt, qrSvg: await QRCode.toString(cur.uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }), uri: cur.uri })
    }
    if (p === '/phone/wifi/pair' && req.method === 'POST') {
      try {
        const r = await companion.startPairing()
        return send(200, { active: true, expiresAt: r.expiresAt, listening: r.hosts.map((h) => `${h}:${r.port}`) })
      } catch (err) {
        return send(503, { error: err.message })
      }
    }
    if (p === '/phone/wifi/cancel' && req.method === 'POST') {
      companion.cancelPairing()
      return send(200, { cancelled: true })
    }
    if (['/phone/wifi/disconnect', '/phone/wifi/reconnect', '/phone/wifi/revoke'].includes(p) && req.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        return send(400, { error: 'bad json' })
      }
      const id = String(body.deviceId ?? '')
      const ok = p.endsWith('revoke') ? await companion.revoke(id) : companion.pause(id, p.endsWith('disconnect'))
      return send(ok ? 200 : 404, { ok })
    }

    if (p === '/phone/revoke' && req.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'))
      } catch {
        return send(400, { error: 'bad json' })
      }
      const s = phone.load()
      if (!s.devices?.[body.serial]) return send(404, { error: 'not paired' })
      if (body.capability === 'location' || body.capability === 'notifications') {
        phone.setPermission(body.serial, body.capability, false)
      } else {
        delete s.devices[body.serial]
        phone.save(s)
      }
      audit({ event: 'integration', integration: 'phone', action: 'revoke', capability: body.capability ?? 'device' })
      return send(200, { revoked: body.capability ?? 'device' })
    }
    return send(405, { error: 'method not allowed' })
  }

  return { registry, memory, identity, google, phone, companion, whatsapp, home, status, handle }
}
