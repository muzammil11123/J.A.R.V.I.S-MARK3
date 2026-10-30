/**
 * Keeps JARVIS running in the background after you sign in to Windows.
 *
 * Started hidden by the "JARVIS" scheduled task (see scripts/autostart.mjs),
 * or by `npm run jarvis:start`. It runs the same launcher you would run by
 * hand — scripts/start.mjs --fast --desktop — from the project folder, so the
 * bridge loads jarvis/.env itself and every policy, approval prompt and
 * credential rule is exactly as it is from a terminal. It runs as you, never
 * elevated.
 *
 * What it adds:
 *   one instance   a lock file in ~/.jarvis/run; a second start opens the HUD
 *                  of the one already running instead of starting another
 *                  server (no EADDRINUSE). A JARVIS started by hand in a
 *                  terminal is detected too, and left alone.
 *   diagnostics    a daily log in ~/.jarvis/logs and a status file saying
 *                  what started, how long it took, and why it stopped.
 *   the HUD        opened as a Chrome (or Edge) app window once the bridge and
 *                  the face both answer, whenever it is asked for: at start,
 *                  by `npm run jarvis:open`, or by the desktop button.
 *   the button     a small draggable button on the desktop (Windows), always
 *                  there while JARVIS runs; a click opens the HUD.
 *                  Started by the sign-in task (--ask), the button first asks
 *                  "Are you in the mood for JARVIS today?". No means silence:
 *                  the HUD is not opened, so no microphone, no voice. The
 *                  answer lasts until the next sign-in.
 *   recovery       a crash restarts it after a growing pause; four crashes in
 *                  ten minutes and it stops trying and says so, rather than
 *                  restarting for ever.
 *   shutdown       `npm run jarvis:stop` asks it to stop; it takes down the
 *                  whole process tree so no orphan keeps a port.
 *
 * The phone needs nothing from here: the bridge reconnects a paired phone by
 * itself. The supervisor only waits a while and records whether it did.
 */

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE = path.join(os.homedir(), '.jarvis')
export const RUN = path.join(STATE, 'run')
export const LOGS = path.join(STATE, 'logs')
export const LOCK = path.join(RUN, 'supervisor.lock')
export const STATUS = path.join(RUN, 'status.json')
export const STOP = path.join(RUN, 'stop.request')
export const OPEN = path.join(RUN, 'open.request')
export const SESSION = path.join(RUN, 'session.json')

const BRIDGE = `http://127.0.0.1:${Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)}`
const START_ARGS = ['scripts/start.mjs', '--fast', '--desktop']
const READY_TIMEOUT_MS = Number(process.env.JARVIS_READY_TIMEOUT_MS ?? 90_000)
const KEEP_LOG_DAYS = 7
const BUTTON = path.join(ROOT, 'scripts', 'desktop-button.ps1')
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * The supervisor's own switches, from the shell or jarvis/.env. Only these
 * names are read: the rest of .env (tokens, secrets) is left for the bridge to
 * load itself, and never reaches the button or the face.
 */
const SWITCHES = ['JARVIS_STARTUP_PROMPT', 'JARVIS_DESKTOP_BUTTON']
function switches() {
  const out = {}
  try {
    const file = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'))
    for (const k of SWITCHES) if (file[k] !== undefined) out[k] = file[k]
  } catch {
    /* no .env */
  }
  for (const k of SWITCHES) if (process.env[k] !== undefined) out[k] = process.env[k]
  return out
}

// ---------------------------------------------------------------------------
// Pure rules, tested in supervisor.test.mjs
// ---------------------------------------------------------------------------

/**
 * Whether to restart after a crash, and how long to wait first. Crashes older
 * than the window are forgotten, so a JARVIS that ran for a day and then fell
 * over is restarted; one that cannot stay up is not.
 *
 * @param {number[]} crashes times of earlier crashes (ms), including this one
 * @returns {{ restart: boolean, waitMs: number, recent: number }}
 */
export function crashPolicy(crashes, now, { windowMs = 10 * 60_000, max = 4, backoff = [5_000, 15_000, 30_000, 60_000] } = {}) {
  const recent = crashes.filter((t) => now - t <= windowMs).length
  if (recent >= max) return { restart: false, waitMs: 0, recent }
  return { restart: true, waitMs: backoff[Math.min(recent - 1, backoff.length - 1)] ?? backoff[0], recent }
}

/**
 * What this start shows. The question is asked only at sign-in (--ask), only
 * where the button can ask it, and then the HUD waits for a yes or a click.
 * Any other start (`npm run jarvis:start`) is someone asking for JARVIS, so
 * the HUD opens when ready, as it always has.
 */
export function startupPlan(argv, env = {}, platform = process.platform) {
  const button = platform === 'win32' && env.JARVIS_DESKTOP_BUTTON !== '0'
  const ask = button && argv.includes('--ask') && env.JARVIS_STARTUP_PROMPT !== '0'
  return { button, ask, openWhenReady: !ask && !argv.includes('--no-open') }
}

/** Is a process with this id alive? */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Take the single-instance lock, or report who holds it. A lock left by a
 * process that no longer exists (a crash, a power cut) is stale and taken over.
 *
 * @returns {{ ok: true } | { ok: false, pid: number }}
 */
export function takeLock(file = LOCK, pid = process.pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: new Date().toISOString() }), { flag: 'wx' })
      return { ok: true }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let holder = 0
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8')).pid
      } catch {
        holder = 0
      }
      if (holder && holder !== pid && alive(holder)) return { ok: false, pid: holder }
      fs.rmSync(file, { force: true })
    }
  }
  return { ok: false, pid: 0 }
}

export function releaseLock(file = LOCK, pid = process.pid) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true })
  } catch {
    /* not ours, or gone */
  }
}

/** Terminal colour codes (ESC [ … m), which have no place in a log file. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
export const stripAnsi = (s) => s.replace(ANSI, '')

/** The face's URL, from Vite's "Local:" line. */
export function faceUrlFrom(text) {
  const m = /Local:\s+(http:\/\/localhost:\d+)/.exec(stripAnsi(text))
  return m ? `${m[1]}/` : null
}

// ---------------------------------------------------------------------------
// Logging and status
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString()
const logFile = () => path.join(LOGS, `jarvis-${stamp().slice(0, 10)}.log`)

export function log(line) {
  fs.mkdirSync(LOGS, { recursive: true })
  // ANSI colour codes from the launcher are for terminals, not log files.
  const clean = stripAnsi(String(line)).trimEnd()
  if (clean) fs.appendFileSync(logFile(), `${stamp()} ${clean}\n`)
}

function pruneLogs() {
  try {
    const cutoff = Date.now() - KEEP_LOG_DAYS * 864e5
    for (const f of fs.readdirSync(LOGS)) {
      const full = path.join(LOGS, f)
      if (/^jarvis-\d{4}-\d{2}-\d{2}\.log$/.test(f) && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full)
    }
  } catch {
    /* nothing to prune */
  }
}

let status = {}
function setStatus(patch) {
  status = { ...status, ...patch, updatedAt: stamp() }
  fs.mkdirSync(RUN, { recursive: true })
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2))
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
    return r.ok ? await r.json().catch(() => ({})) : null
  } catch {
    return null
  }
}

const bridgeHealthy = async () => (await get(`${BRIDGE}/health`))?.ok === true

async function waitFor(check, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await check()
    if (v) return v
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return null
}

// ---------------------------------------------------------------------------
// The HUD
// ---------------------------------------------------------------------------

function browserPath() {
  const env = process.env
  const candidates = [
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) ?? null
}

/** The HUD's own Chrome profile, apart from the one you browse with. */
export const HUD_PROFILE = path.join(STATE, 'hud-profile')

/**
 * A Chrome app window (no tabs or address bar) in its own Chrome instance.
 *
 * Sharing your everyday Chrome cost the reactor: after its GPU process
 * crashes a few times Chrome switches WebGL off until every window is closed,
 * and any flag passed here is ignored by a Chrome that is already running. A
 * profile of its own means these flags always apply: no crash limit, and
 * software WebGL if the GPU is refused, so the 3D reactor always has a
 * context. It asks for the microphone once; Chrome remembers it in this
 * profile. Browser control is unaffected: it goes through the extension in
 * your normal Chrome. Falls back to the default browser.
 */
export function hudArgs(url, profile = HUD_PROFILE) {
  return [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-process-crash-limit',
    '--enable-unsafe-swiftshader',
    // A fresh profile has no autoplay history, so Chrome holds back speech
    // until a click; replies then sit on PROCESSING while each sentence
    // times out. JARVIS talks unprompted by design.
    '--autoplay-policy=no-user-gesture-required',
  ]
}

export function openHud(url) {
  const browser = browserPath()
  const child = browser
    ? spawn(browser, hudArgs(url), { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' })
  child.on('error', (err) => log(`[supervisor] could not open the HUD: ${err.message}`))
  child.unref()
  log(`[supervisor] opened the HUD at ${url} in ${browser ? path.basename(browser) : 'the default browser'}`)
}

/** This sign-in's answer to the startup question: 'yes', 'no', or null if not asked. */
export function sessionChoice(file = SESSION) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).choice ?? null
  } catch {
    return null
  }
}

/** Ask the running supervisor for the HUD; it opens it as soon as it is ready. */
export function requestHud() {
  fs.mkdirSync(RUN, { recursive: true })
  fs.writeFileSync(OPEN, new Date().toISOString())
}

/** One message box, on final failure only. */
function notify(text) {
  if (process.platform !== 'win32') return
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(@'\n${text.replace(/'@/g, "' @")}\n'@, 'JARVIS', 'OK', 'Warning') | Out-Null`
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** The whole process tree, so neither the bridge nor Vite outlives it. */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!alive(pid)) return resolve()
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        /* gone */
      }
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

async function main() {
  const plan = startupPlan(process.argv, switches())

  // Someone else's JARVIS — a terminal `npm run start:desktop` — already
  // owns the ports. Do not start a second; show the one that is running.
  const lock = takeLock()
  if (!lock.ok) {
    log(`[supervisor] already running (pid ${lock.pid}); not starting another.`)
    if (plan.openWhenReady) requestHud()
    return
  }
  if (await bridgeHealthy()) {
    log('[supervisor] a JARVIS started outside autostart is already answering on the bridge port; leaving it alone.')
    releaseLock()
    if (plan.openWhenReady) openHud('http://localhost:5173/')
    return
  }

  // A new session: yesterday's answer and any unserved request are forgotten.
  for (const f of [STOP, OPEN, SESSION]) fs.rmSync(f, { force: true })
  pruneLogs()
  log(`[supervisor] starting JARVIS from ${ROOT} as ${os.userInfo().username} (pid ${process.pid}, node ${process.version})`)
  log(`[supervisor] desktop button ${plan.button ? 'on' : 'off'} · ${plan.ask ? 'asking whether you want JARVIS today' : plan.openWhenReady ? 'HUD opens when ready' : 'HUD opens on request'}`)
  setStatus({ state: 'starting', pid: process.pid, startedAt: stamp(), restarts: 0, lastError: null, url: null, phone: null })
  if (plan.openWhenReady) requestHud()

  let child = null
  let button = null
  let lastHudAt = 0
  let stopping = false
  const crashes = []
  const buttonCrashes = []

  // The desktop button. The question goes with the first one only: if the
  // button has to be restarted, it comes back without asking again.
  const startButton = (ask) => {
    if (!fs.existsSync(BUTTON) || !fs.existsSync(POWERSHELL)) {
      log('[supervisor] desktop button unavailable (Windows PowerShell not found); the HUD opens when ready instead')
      requestHud()
      return
    }
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', BUTTON,
      '-RunDir', RUN, '-SupervisorPid', String(process.pid), '-Node', process.execPath, '-Root', ROOT]
    if (ask) args.push('-Ask')
    button = spawn(POWERSHELL, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const onOutput = (d) => {
      for (const line of d.toString().split(/\r?\n/)) log(line)
    }
    button.stdout.on('data', onOutput)
    button.stderr.on('data', onOutput)
    button.once('error', (err) => log(`[supervisor] could not start the desktop button: ${err.message}`))
    button.once('exit', (code) => {
      button = null
      if (stopping || code === 0) return
      buttonCrashes.push(Date.now())
      const d = crashPolicy(buttonCrashes, Date.now())
      if (!d.restart) return log('[supervisor] the desktop button keeps failing; JARVIS carries on without it (npm run jarvis:open still works)')
      log(`[supervisor] desktop button exited (code ${code}); restarting it in ${d.waitMs / 1000} s`)
      setTimeout(() => !stopping && startButton(false), d.waitMs)
    })
  }

  const stop = async (why) => {
    if (stopping) return
    stopping = true
    log(`[supervisor] stopping (${why})`)
    setStatus({ state: 'stopping' })
    if (button) await killTree(button.pid)
    if (child) await killTree(child.pid)
    setStatus({ state: 'stopped', stoppedAt: stamp(), stopReason: why })
    releaseLock()
    for (const f of [STOP, OPEN]) fs.rmSync(f, { force: true })
    log('[supervisor] stopped')
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('interrupted'))
  process.on('SIGTERM', () => void stop('terminated'))
  process.on('SIGBREAK', () => void stop('console closed'))
  // Requests arrive as files, because a hidden process on Windows has no
  // console to send Ctrl-C to: stop.request from `npm run jarvis:stop` or the
  // button's Exit, open.request from a click, a yes, or `npm run jarvis:open`.
  const requests = setInterval(() => {
    if (fs.existsSync(STOP)) return void stop('stop requested')
    if (status.state === 'running' && status.url && fs.existsSync(OPEN)) {
      fs.rmSync(OPEN, { force: true })
      // One HUD. A burst of requests (quick clicks) opened a window each, and
      // two HUDs are two microphones cancelling each other's questions.
      if (Date.now() - lastHudAt < 20_000) return log('[supervisor] HUD opened moments ago; not opening another')
      lastHudAt = Date.now()
      openHud(status.url)
    }
  }, 1000)
  requests.unref?.()

  if (plan.button) startButton(plan.ask)

  const launch = async () => {
    const started = Date.now()
    let url = null
    let hung = false
    child = spawn(process.execPath, START_ARGS, { cwd: ROOT, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } })
    log(`[supervisor] launcher started (pid ${child.pid})`)
    const onOutput = (d) => {
      const text = d.toString()
      for (const line of text.split(/\r?\n/)) log(line)
      url ??= faceUrlFrom(text)
    }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onOutput)

    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.once('error', (err) => log(`[supervisor] could not start the launcher: ${err.message}`))

    // Diagnostics: how long each half took to answer.
    const ready = await Promise.race([
      waitFor(async () => (await bridgeHealthy()) && url, READY_TIMEOUT_MS),
      exited.then(() => null),
    ])
    if (ready) {
      log(`[supervisor] ready in ${((Date.now() - started) / 1000).toFixed(1)} s · bridge ${BRIDGE} · HUD ${url}`)
      // A pending open.request is served by the request watcher within a second.
      setStatus({ state: 'running', url, readyAt: stamp(), readySeconds: +((Date.now() - started) / 1000).toFixed(1), launcherPid: child.pid })
      // The paired phone reconnects by itself; this only records whether it did.
      void waitFor(async () => {
        const w = await get(`${BRIDGE}/phone/wifi`, { origin: 'http://localhost:5173' })
        // No answer is not "no phone": the bridge may be busy or restarting.
        if (!w) return null
        if (!w.devices?.length) return 'none paired'
        return w.devices.some((d) => d.connected) ? 'connected' : null
      }, 120_000, 3000).then((phone) => {
        const result = phone ?? 'paired but not connected yet (is it on the same Wi-Fi?)'
        log(`[supervisor] phone over Wi-Fi: ${result}`)
        if (!stopping) setStatus({ phone: result })
      })
    } else if (!stopping) {
      // A start that hangs is a failed start, not one to wait on for ever.
      // (Seen for real: another program held the bridge port on IPv4 while
      // JARVIS bound it on IPv6, so nothing crashed and nothing answered.)
      log(`[supervisor] JARVIS did not become ready within ${READY_TIMEOUT_MS / 1000} s; stopping this attempt`)
      hung = true
      await killTree(child.pid)
    }

    const { code, signal } = await exited
    if (stopping) return
    const why = hung ? `did not become ready within ${READY_TIMEOUT_MS / 1000} s (is another program using port 8787?)` : `launcher exited (${signal ?? `code ${code}`})`
    log(`[supervisor] ${why}`)
    await killTree(child.pid) // anything it left behind
    crashes.push(Date.now())
    const decision = crashPolicy(crashes, Date.now())
    if (!decision.restart) {
      const msg =
        `JARVIS stopped ${decision.recent} times in 10 minutes, so it will not restart on its own.\n\n` +
        `Log: ${logFile()}\n\nFix the problem, then run: npm run jarvis:start`
      log(`[supervisor] giving up: ${decision.recent} crashes in 10 minutes`)
      setStatus({ state: 'failed', lastError: why, failedAt: stamp() })
      stopping = true
      if (button) await killTree(button.pid)
      // "No" at sign-in promised no popups; then the log and jarvis:status say it.
      if (sessionChoice() !== 'no') notify(msg)
      releaseLock()
      clearInterval(requests)
      process.exit(1)
    }
    setStatus({ state: 'restarting', restarts: (status.restarts ?? 0) + 1, lastError: why })
    log(`[supervisor] restarting in ${decision.waitMs / 1000} s (crash ${decision.recent} of 4 allowed in 10 minutes)`)
    await new Promise((r) => setTimeout(r, decision.waitMs))
    if (!stopping) await launch()
  }

  await launch()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log(`[supervisor] fatal: ${err?.stack ?? err}`)
    releaseLock()
    process.exit(1)
  })
}
