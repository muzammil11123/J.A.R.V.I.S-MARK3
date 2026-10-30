import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { crashPolicy, takeLock, releaseLock, faceUrlFrom, alive, startupPlan, sessionChoice, hudArgs } from './supervisor.mjs'
import { launcherScript, taskXml } from './autostart.mjs'

test('crashes restart with growing pauses, and four in ten minutes stop it for good', () => {
  const t = 1_000_000_000
  assert.deepEqual(crashPolicy([t], t), { restart: true, waitMs: 5_000, recent: 1 })
  assert.equal(crashPolicy([t - 60_000, t], t).waitMs, 15_000)
  assert.equal(crashPolicy([t - 120_000, t - 60_000, t], t).waitMs, 30_000)
  const four = crashPolicy([t - 180_000, t - 120_000, t - 60_000, t], t)
  assert.equal(four.restart, false)
  // Old crashes are forgotten: a day of uptime then one crash restarts.
  assert.equal(crashPolicy([t - 864e5, t - 864e5 + 1, t - 864e5 + 2, t], t).restart, true)
})

test('only one supervisor holds the lock; a stale lock is taken over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lock-'))
  const file = path.join(dir, 'supervisor.lock')
  // A real, live process holds it.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore' })
  try {
    assert.deepEqual(takeLock(file, holder.pid), { ok: true })
    const second = takeLock(file, process.pid)
    assert.deepEqual(second, { ok: false, pid: holder.pid })
  } finally {
    holder.kill()
  }
  await new Promise((r) => holder.once('exit', r))
  assert.equal(alive(holder.pid), false)
  // Its holder is gone, so the lock is stale and ours to take.
  assert.deepEqual(takeLock(file, process.pid), { ok: true })
  releaseLock(file, 123456789)
  assert.ok(fs.existsSync(file), 'someone else cannot release our lock')
  releaseLock(file, process.pid)
  assert.equal(fs.existsSync(file), false)
})

test('the HUD address is read from Vite’s output, colours and all', () => {
  assert.equal(faceUrlFrom('face   \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m'), 'http://localhost:5174/')
  assert.equal(faceUrlFrom('bridge [jarvis] model claude-haiku-5-5'), null)
})

test('the scheduled task runs as the user, least privilege, one copy, no time limit', () => {
  const xml = taskXml('DESKTOP-1\\tony', 'C:\\Users\\tony\\.jarvis\\autostart\\start-jarvis.vbs')
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/)
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/)
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.match(xml, /<UserId>DESKTOP-1\\tony<\/UserId>/)
  assert.doesNotMatch(xml, /HighestAvailable/)
  assert.match(xml, /wscript\.exe/)
})

test('the hidden launcher quotes paths with spaces, runs from the project folder, and asks first', () => {
  const vbs = launcherScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\tony\\My Stuff\\jarvis')
  assert.match(vbs, /sh\.CurrentDirectory = "C:\\Users\\tony\\My Stuff\\jarvis"/)
  assert.match(vbs, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\tony\\My Stuff\\jarvis\\scripts\\supervisor\.mjs"" --ask", 0, False/)
})

test('only the sign-in start asks; the HUD then waits for a yes or a click', () => {
  // Sign-in on Windows: button, question, HUD on request only.
  assert.deepEqual(startupPlan(['node', 'supervisor.mjs', '--ask'], {}, 'win32'), { button: true, ask: true, openWhenReady: false })
  // npm run jarvis:start is already a yes: button, no question, HUD when ready.
  assert.deepEqual(startupPlan(['node', 'supervisor.mjs'], {}, 'win32'), { button: true, ask: false, openWhenReady: true })
  // Question switched off: back to opening the HUD at sign-in.
  assert.deepEqual(startupPlan(['--ask'], { JARVIS_STARTUP_PROMPT: '0' }, 'win32'), { button: true, ask: false, openWhenReady: true })
  // No button, nothing to ask with.
  assert.deepEqual(startupPlan(['--ask'], { JARVIS_DESKTOP_BUTTON: '0' }, 'win32'), { button: false, ask: false, openWhenReady: true })
  assert.deepEqual(startupPlan(['--ask'], {}, 'linux'), { button: false, ask: false, openWhenReady: true })
  assert.equal(startupPlan(['--no-open'], {}, 'win32').openWhenReady, false)
})

test('the sign-in answer is read back, and a missing or broken file means not asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-session-'))
  const file = path.join(dir, 'session.json')
  assert.equal(sessionChoice(file), null)
  fs.writeFileSync(file, '{"choice":"no","how":"clicked"}')
  assert.equal(sessionChoice(file), 'no')
  fs.writeFileSync(file, '{not json')
  assert.equal(sessionChoice(file), null)
})

test('the desktop button script is ASCII, so Windows PowerShell 5.1 reads it intact', () => {
  const ps1 = fs.readFileSync(new URL('./desktop-button.ps1', import.meta.url))
  assert.ok(ps1.every((b) => b < 0x80), 'desktop-button.ps1 contains a non-ASCII byte')
})

test('the HUD runs in its own Chrome, where the WebGL safeguards always apply', () => {
  const args = hudArgs('http://localhost:5173/', '/tmp/hud-profile')
  assert.ok(args.includes('--user-data-dir=/tmp/hud-profile'))
  assert.ok(args.includes('--app=http://localhost:5173/'))
  assert.ok(args.includes('--disable-gpu-process-crash-limit'))
  assert.ok(args.includes('--enable-unsafe-swiftshader'))
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
})
