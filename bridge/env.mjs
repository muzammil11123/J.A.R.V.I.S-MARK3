/**
 * Bridge settings from jarvis/.env, for anyone who would rather not set
 * environment variables by hand on Windows.
 *
 * Imported first by server.mjs, so every module sees the values. A variable
 * already set in the shell always wins. The file is gitignored, and
 * policy.mjs refuses any model tool that tries to read it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const file = fileURLToPath(new URL('../.env', import.meta.url))

if (existsSync(file)) {
  let loaded = 0
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded++
    }
  }
  // Names only. Values are never printed.
  console.log(`[jarvis] read ${loaded} setting${loaded === 1 ? '' : 's'} from .env`)
}
