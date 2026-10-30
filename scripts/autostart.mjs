/**
 * Start JARVIS when you sign in to Windows, and the controls to go with it.
 *
 *   npm run jarvis:enable    start at every sign-in (a Task Scheduler task)
 *   npm run jarvis:disable   stop starting at sign-in (and remove the shortcuts)
 *   npm run jarvis:start     start it now, in the background
 *   npm run jarvis:stop      shut it down completely
 *   npm run jarvis:status    is it set up, running, healthy, phone connected?
 *   npm run jarvis:open      open the HUD of the running JARVIS
 *   npm run jarvis:logs      where the logs are, and the latest lines
 *
 * Why Task Scheduler rather than the Startup folder: the task runs as you
 * with the lowest privileges (no administrator rights, no UAC prompt), it can
 * refuse a second copy, it waits a moment after sign-in so the network is up,
 * and enabling or disabling it is one command. The task starts a tiny
 * launcher (wscript) that runs the supervisor with no console window.
 *
 * Only the sign-in start asks "Are you in the mood for JARVIS today?" (the
 * launcher passes --ask). `npm run jarvis:start` is already the answer, so it
 * opens the HUD without asking.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, STATE, RUN, LOGS, LOCK, STATUS, STOP, alive, killTree, openHud, requestHud, sessionChoice } from './supervisor.mjs'

const TASK = 'JARVIS'
const AUTOSTART = path.join(STATE, 'autostart')
const LAUNCHER = path.join(AUTOSTART, 'start-jarvis.vbs')
const MENU = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'JARVIS')

const run = (file, args) =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })))

const quoteVbs = (s) => `"${s.replace(/"/g, '""')}"`
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The hidden launcher: runs the supervisor from the project folder, no window, and asks first. */
export function launcherScript(node = process.execPath, root = ROOT) {
  const supervisor = path.join(root, 'scripts', 'supervisor.mjs')
  return [
    "' Starts JARVIS in the background at sign-in. Written by `npm run jarvis:enable`.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${quoteVbs(root)}`,
    `sh.Run ${quoteVbs(`"${node}" "${supervisor}" --ask`)}, 0, False`,
    '',
  ].join('\r\n')
}

/** The scheduled task: at your sign-in, as you, least privilege, one copy. */
export function taskXml(userId, launcher = LAUNCHER) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the JARVIS assistant in the background when ${xmlEscape(userId)} signs in. Disable with: npm run jarvis:disable</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
      <Delay>PT20S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo "${xmlEscape(launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** Start-menu entries, so stopping and disabling need no terminal. */
function writeShortcuts(node) {
  fs.mkdirSync(MENU, { recursive: true })
  const cmd = (verb) =>
    ['@echo off', `cd /d "${ROOT}"`, `"${node}" scripts\\autostart.mjs ${verb}`, verb === 'open' ? '' : 'timeout /t 4 >nul', ''].join('\r\n')
  fs.writeFileSync(path.join(MENU, 'Open JARVIS.cmd'), cmd('open'))
  fs.writeFileSync(path.join(MENU, 'Stop JARVIS.cmd'), cmd('stop'))
  fs.writeFileSync(path.join(MENU, 'Start JARVIS.cmd'), cmd('start'))
  fs.writeFileSync(path.join(MENU, 'Disable JARVIS autostart.cmd'), cmd('disable'))
}

async function whoAmI() {
  const r = await run('whoami', [])
  return r.stdout.trim() || `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS, 'utf8'))
  } catch {
    return null
  }
}

function supervisorPid() {
  try {
    const pid = JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid
    return alive(pid) ? pid : null
  } catch {
    return null
  }
}

async function health() {
  try {
    const r = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

const commands = {
  async enable() {
    if (process.platform !== 'win32') throw new Error('Autostart is set up for Windows only.')
    fs.mkdirSync(AUTOSTART, { recursive: true })
    fs.writeFileSync(LAUNCHER, launcherScript())
    const user = await whoAmI()
    const xmlFile = path.join(AUTOSTART, 'task.xml')
    // Task Scheduler wants UTF-16 with a byte-order mark.
    fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(user), 'utf16le')]))
    const r = await run('schtasks', ['/Create', '/TN', TASK, '/XML', xmlFile, '/F'])
    if (r.code !== 0) throw new Error(`Task Scheduler refused the task: ${(r.stderr || r.stdout).trim()}`)
    writeShortcuts(process.execPath)
    console.log(`Autostart enabled: JARVIS starts 20 s after ${user} signs in (no administrator rights).`)
    console.log(`Start menu → JARVIS has Open, Start, Stop and Disable entries.`)
    console.log('Start it now without signing out: npm run jarvis:start')
  },

  async disable() {
    const r = await run('schtasks', ['/Delete', '/TN', TASK, '/F'])
    const gone = r.code === 0 || /cannot find|does not exist/i.test(r.stderr)
    fs.rmSync(MENU, { recursive: true, force: true })
    console.log(gone ? 'Autostart disabled: JARVIS will not start at sign-in.' : `Could not remove the task: ${r.stderr.trim()}`)
    console.log(supervisorPid() ? 'JARVIS is still running now; stop it with: npm run jarvis:stop' : 'JARVIS is not running.')
  },

  async start() {
    if (supervisorPid()) {
      console.log('JARVIS is already running; opening the HUD.')
      return commands.open()
    }
    // Not through the sign-in launcher: that one asks first, and this is a yes.
    spawn(process.execPath, [path.join(ROOT, 'scripts', 'supervisor.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    console.log('Starting JARVIS in the background. The HUD opens when it is ready (usually 10-30 s).')
    console.log('Check on it with: npm run jarvis:status')
  },

  async stop() {
    const pid = supervisorPid()
    if (!pid) {
      console.log((await health()) ? 'JARVIS was started from a terminal, not autostart. Stop it there with Ctrl-C.' : 'JARVIS is not running.')
      return
    }
    fs.mkdirSync(RUN, { recursive: true })
    fs.writeFileSync(STOP, new Date().toISOString())
    process.stdout.write('Stopping JARVIS')
    for (let i = 0; i < 20 && alive(pid); i++) {
      await new Promise((r) => setTimeout(r, 500))
      process.stdout.write('.')
    }
    if (alive(pid)) {
      // It did not answer the request in time: take the tree down directly.
      const launcher = readStatus()?.launcherPid
      if (launcher) await killTree(launcher)
      await killTree(pid)
      fs.rmSync(LOCK, { force: true })
    }
    console.log(' stopped.')
  },

  async status() {
    const task = await run('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST', '/V'])
    const field = (name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(task.stdout)?.[1]?.trim()
    const s = readStatus()
    const pid = supervisorPid()
    console.log(`Autostart at sign-in : ${task.code === 0 ? `enabled (${field('Scheduled Task State') ?? '?'}, last run ${field('Last Run Time') ?? '?'}, result ${field('Last Result') ?? '?'})` : 'disabled'}`)
    console.log(`Supervisor           : ${pid ? `running (pid ${pid})` : 'not running'}`)
    console.log(`Bridge health        : ${(await health()) ? 'answering' : 'not answering'}`)
    if (s) {
      console.log(`State                : ${s.state}${s.readySeconds ? ` (ready in ${s.readySeconds} s)` : ''}${s.restarts ? `, ${s.restarts} restart(s)` : ''}`)
      if (s.url) console.log(`HUD                  : ${s.url}`)
      if (s.phone) console.log(`Phone over Wi-Fi     : ${s.phone}`)
      if (pid) {
        const choice = sessionChoice()
        console.log(`Asked at sign-in     : ${choice === 'yes' ? 'yes' : choice === 'no' ? 'no (silent; the desktop button opens the HUD)' : 'not asked this session'}`)
      }
      if (s.lastError) console.log(`Last problem         : ${s.lastError}`)
    }
    console.log(`Logs                 : ${LOGS}`)
  },

  async open() {
    if (supervisorPid()) {
      requestHud()
      console.log('Opening the JARVIS HUD (as soon as JARVIS is ready).')
    } else if (await health()) {
      openHud('http://localhost:5173/')
      console.log('Opening the JARVIS HUD.')
    } else {
      console.log('JARVIS is not running. Start it with: npm run jarvis:start')
    }
  },

  async logs() {
    const files = fs.existsSync(LOGS) ? fs.readdirSync(LOGS).filter((f) => f.endsWith('.log')).sort() : []
    if (!files.length) return console.log(`No logs yet in ${LOGS}`)
    const latest = path.join(LOGS, files.at(-1))
    console.log(`${latest}\n`)
    console.log(fs.readFileSync(latest, 'utf8').split('\n').slice(-40).join('\n'))
  },
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verb = process.argv[2]
  if (!commands[verb]) {
    console.log('Usage: node scripts/autostart.mjs enable|disable|start|stop|status|open|logs')
    process.exit(verb ? 1 : 0)
  }
  commands[verb]().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
