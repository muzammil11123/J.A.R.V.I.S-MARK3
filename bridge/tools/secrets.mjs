/**
 * Where JARVIS keeps tokens it is given at run time — the Google refresh
 * token, chiefly. Keys you supply yourself belong in the environment.
 *
 * On Windows each secret is encrypted with DPAPI under your Windows account,
 * so the file is useless copied to another machine or read by another user.
 * Elsewhere it is a file only you can read. Either way it lives in
 * ~/.jarvis/secrets, which policy.mjs puts out of reach of every model tool,
 * and its contents are never logged or sent to the model.
 *
 * DPAPI is reached through PowerShell, which is slow to start on some
 * machines; values are cached in memory after the first read.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const PROTECT =
  'Add-Type -AssemblyName System.Security;$t=[Console]::In.ReadToEnd();' +
  '$b=[Text.Encoding]::UTF8.GetBytes($t);' +
  '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
const UNPROTECT =
  'Add-Type -AssemblyName System.Security;$t=[Console]::In.ReadToEnd().Trim();' +
  '$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Text.Encoding]::UTF8.GetString($b)'

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,40}$/

/**
 * @param {{ dir: string, platform?: string, run: typeof import('./exec.mjs').run }} opts
 */
export function secretStore({ dir, platform = process.platform, run }) {
  const cache = new Map()
  const dpapi = platform === 'win32'
  const fileOf = (name) => {
    if (!SAFE_NAME.test(name)) throw new Error(`bad secret name ${name}`)
    return path.join(dir, `${name}.${dpapi ? 'dpapi' : 'json'}`)
  }
  const ps = (script, input) =>
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, timeoutMs: 60_000 })

  return {
    encrypted: dpapi,

    has(name) {
      return cache.has(name) || fs.existsSync(fileOf(name))
    },

    async get(name) {
      if (cache.has(name)) return cache.get(name)
      const file = fileOf(name)
      let text
      try {
        text = await fsp.readFile(file, 'utf8')
      } catch {
        return null
      }
      if (dpapi) {
        const { stdout, code } = await ps(UNPROTECT, text)
        if (code !== 0 || !stdout.trim()) throw new Error('the stored secret could not be decrypted under this Windows account')
        text = stdout
      }
      const value = JSON.parse(text)
      cache.set(name, value)
      return value
    },

    async set(name, value) {
      const file = fileOf(name)
      await fsp.mkdir(dir, { recursive: true })
      let text = JSON.stringify(value)
      if (dpapi) {
        const { stdout, code } = await ps(PROTECT, text)
        if (code !== 0 || !stdout.trim()) throw new Error('the secret could not be encrypted')
        text = stdout.trim()
      }
      await fsp.writeFile(file, text, { mode: 0o600 })
      cache.set(name, value)
    },

    async remove(name) {
      cache.delete(name)
      await fsp.rm(fileOf(name), { force: true })
    },
  }
}
