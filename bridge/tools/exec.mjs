/**
 * Running a program for a tool, without a shell.
 *
 * Every integration that needs a subprocess — adb, tasklist, the screenshot
 * script — goes through here, and here never hands a string to a shell. The
 * program and each argument are separate, so nothing a model or a contact
 * name contains can become a second command. Cancellation kills the child.
 */

import { execFile } from 'node:child_process'
import { ToolError, ERR } from './registry.mjs'

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, timeoutMs?: number, input?: string, maxBuffer?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function run(file, args, { signal, timeoutMs = 20_000, input, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { signal, timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: 'utf8', shell: false },
      (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') {
          return reject(new ToolError(ERR.NOT_CONFIGURED, `${file} is not installed or not on PATH.`))
        }
        if (err?.name === 'AbortError') return reject(new ToolError(ERR.CANCELLED, 'Cancelled.'))
        if (err?.killed) return reject(new ToolError(ERR.TIMEOUT, `${file} did not finish in time.`, { retryable: true }))
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof err?.code === 'number' ? err.code : 0 })
      },
    )
    if (input != null) {
      child.stdin?.end(input)
    }
  })
}
