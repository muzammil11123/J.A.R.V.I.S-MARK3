/**
 * Handing a prepared WhatsApp chat to this PC: WhatsApp Desktop first, then
 * WhatsApp Web in Chrome.
 *
 * Why not `explorer.exe https://wa.me/...`, which is what this used to do.
 * Measured on Windows 11 (build 26300): explorer.exe given a URL by a
 * background process opens nothing at all and exits 1 — which it also does
 * when it works, so the code that ignored the exit code reported a chat as
 * opened when no window had appeared. And even when a browser does open,
 * wa.me is a landing page in the default browser (Edge, here), not a
 * handoff to the desktop app.
 *
 * What WhatsApp Desktop registers is the `whatsapp:` protocol, and
 * `whatsapp://send?phone=<digits>&text=<text>` is the link the wa.me page
 * itself hands to the app. It is opened with ShellExecute through
 * `rundll32 url.dll,FileProtocolHandler` (1.5 s here; Start-Process does the
 * same but PowerShell takes 6 s to start on this PC). Neither says whether
 * the app opened — Windows answers an unregistered scheme with a "pick an
 * app" dialog, not an error — so the protocol's registration is checked
 * first and WhatsApp's process afterwards.
 *
 * Nothing here reads WhatsApp's window, session or storage, types into it or
 * presses send. Whether the chat finished loading is something only the
 * person looking at it can see, and every result says so.
 */

import { existsSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { ToolError, ERR } from './registry.mjs'

export const desktopLink = (digits, text) => `whatsapp://send?phone=${digits}${text ? `&text=${encodeURIComponent(text)}` : ''}`
export const webLink = (digits, text) => `https://web.whatsapp.com/send?phone=${digits}${text ? `&text=${encodeURIComponent(text)}` : ''}`

/** Well under the 32,767-character Windows command line, with room for PowerShell around it. */
export const MAX_LINK = 30_000

/** WhatsApp Desktop's process: the Store app is WhatsApp.Root.exe, the old installer WhatsApp.exe. */
const PROCESSES = ['WhatsApp.Root.exe', 'WhatsApp.exe']

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new ToolError(ERR.CANCELLED, 'Cancelled.'))
    }, { once: true })
  })

/**
 * @param {{ run: typeof import('./exec.mjs').run, platform?: string,
 *           env?: Record<string, string|undefined>, exists?: (p: string) => boolean,
 *           resolve?: (host: string) => Promise<unknown> }} deps
 */
export function windowsWhatsApp({ run, platform = process.platform, env = process.env, exists = existsSync, resolve = lookup }) {
  const windows = platform === 'win32'

  /**
   * The link is one argument to a program run without a shell, and
   * percent-encoded besides, so nothing in a message can become a command.
   */
  async function shellOpen(uri, signal) {
    if (uri.length > MAX_LINK) throw new ToolError(ERR.INVALID_ARGS, 'The message is too long to hand to WhatsApp in a link. Shorten it.')
    const [file, args] = windows ? ['rundll32.exe', ['url.dll,FileProtocolHandler', uri]] : [platform === 'darwin' ? 'open' : 'xdg-open', [uri]]
    const r = await run(file, args, { signal, timeoutMs: 15_000 })
    if (r.code !== 0) throw new ToolError(ERR.FAILED, `Could not open the link (${(r.stderr || `exit ${r.code}`).trim().split(/\r?\n/)[0].slice(0, 200)}).`)
  }

  return {
    shellOpen,

    /** Whether WhatsApp Desktop has registered the whatsapp: protocol on this PC. */
    async desktopInstalled(signal) {
      if (!windows) return false
      const r = await run('reg.exe', ['query', 'HKCR\\whatsapp', '/v', 'URL Protocol'], { signal, timeoutMs: 5_000 })
      return r.code === 0
    },

    async desktopRunning(signal) {
      if (!windows) return false
      const r = await run('tasklist.exe', ['/NH', '/FO', 'CSV'], { signal, timeoutMs: 8_000 })
      const out = r.stdout.toLowerCase()
      return PROCESSES.some((p) => out.includes(`"${p.toLowerCase()}"`))
    },

    /**
     * Open the chat in WhatsApp Desktop, then wait for its process to be up.
     * That is the most this can confirm: the link reached the app.
     */
    async openDesktop(digits, text, signal, { waitMs = 8_000 } = {}) {
      await shellOpen(desktopLink(digits, text), signal)
      const until = Date.now() + waitMs
      do {
        if (await this.desktopRunning(signal)) return true
        await sleep(500, signal)
      } while (Date.now() < until)
      return false
    },

    chromePath() {
      const candidates = [
        env.JARVIS_CHROME_PATH,
        env.ProgramFiles && join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
      return candidates.find((p) => p && exists(p)) ?? null
    },

    /** WhatsApp Web in Chrome when it is installed, otherwise the default browser. */
    async openWeb(digits, text, signal) {
      const url = webLink(digits, text)
      const chrome = windows ? this.chromePath() : null
      if (!chrome) {
        await shellOpen(url, signal)
        return 'default_browser'
      }
      if (url.length > MAX_LINK) throw new ToolError(ERR.INVALID_ARGS, 'The message is too long to hand to WhatsApp in a link. Shorten it.')
      // Chrome hands the URL to its running instance and exits; a failure to
      // start at all is an error from run(), a refusal is a non-zero code.
      const r = await run(chrome, [url], { signal, timeoutMs: 15_000 })
      if (r.code !== 0) throw new ToolError(ERR.FAILED, `Chrome could not open WhatsApp Web (exit ${r.code}).`)
      return 'chrome'
    },

    /** A name lookup for WhatsApp Web: the cheapest honest answer to "is this PC online". */
    async online() {
      let timer
      try {
        await Promise.race([resolve('web.whatsapp.com'), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), 3_000)))])
        return true
      } catch {
        return false
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
