import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Registry, createTickets, ERR } from './registry.mjs'
import { desktopTools, matchApps, parseTasklist } from './desktop.mjs'

let root
let ctx
let reg
let launched
const tickets = createTickets()

const call = async (name, args) => {
  const full = `mcp__jarvis_pc__${name}`
  const decision = await reg.authorize(full, args)
  if (decision.verdict !== 'deny') tickets.grant(full, args)
  const out = decision.verdict === 'deny' ? null : await reg.execute(full, args, { tickets })
  return { decision, out }
}

const touch = (rel, body = 'x', ageDays = 0) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * 864e5)
    fs.utimesSync(file, t, t)
  }
  return file
}

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pc-')))
  ctx = { platform: process.platform, home: root, cwd: root, roots: [root], readRoots: [root], exists: fs.existsSync }
  launched = []
  const run = async (file, args) => {
    launched.push([file, ...args])
    return { stdout: '', stderr: '', code: 0 }
  }
  const backups = path.join(root, '..', `${path.basename(root)}-bak`)
  reg = new Registry({ ctx }).add(
    desktopTools({
      run,
      stateDir: path.join(root, '.state'),
      backup: (f) => {
        fs.mkdirSync(backups, { recursive: true })
        const copy = path.join(backups, path.basename(f))
        fs.copyFileSync(f, copy)
        return copy
      },
    }),
  )
  touch('Downloads/report.pdf', 'p'.repeat(5000))
  touch('Downloads/old-invoice.pdf', 'p', 400)
  touch('Downloads/notes.txt', 'hello world')
  touch('Downloads/photo.JPG', 'j'.repeat(20))
  touch('Documents/plan.md', '# plan')
  touch('.env', 'API_KEY=sk-live-123')
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('find_files filters by extension, name, size and age', async () => {
  const pdfs = (await call('find_files', { extensions: ['pdf'] })).out.result
  assert.equal(pdfs.total, 2)
  const recent = (await call('find_files', { extensions: ['.pdf'], modified_within_days: 30 })).out.result
  assert.deepEqual(recent.files.map((f) => path.basename(f.path)), ['report.pdf'])
  const big = (await call('find_files', { min_bytes: 1000 })).out.result
  assert.deepEqual(big.files.map((f) => path.basename(f.path)), ['report.pdf'])
  const named = (await call('find_files', { name: 'INVOICE' })).out.result
  assert.equal(named.total, 1)
  const glob = (await call('find_files', { name: '*.jpg' })).out.result
  assert.equal(glob.total, 1)
})

test('searches never surface credential files', async () => {
  const all = (await call('find_files', { limit: 500 })).out.result
  assert.ok(!all.files.some((f) => path.basename(f.path) === '.env'))
  const { decision } = await call('read_text_file', { path: path.join(root, '.env') })
  // read_text_file is a read: allowed by policy, refused at execution.
  assert.equal(decision.verdict, 'allow')
  const out = (await call('read_text_file', { path: path.join(root, '.env') })).out
  assert.equal(out.error.code, ERR.PERMISSION_DENIED)
})

test('count_files totals sizes', async () => {
  const r = (await call('count_files', { folder: path.join(root, 'Downloads') })).out.result
  assert.equal(r.count, 4)
  assert.ok(r.total_bytes >= 5000)
})

test('read_text_file returns text labelled as untrusted, and refuses outside the roots', async () => {
  const r = (await call('read_text_file', { path: path.join(root, 'Downloads', 'notes.txt') })).out.result
  assert.equal(r.untrusted_content.text, 'hello world')
  const out = (await call('read_text_file', { path: path.join(os.homedir(), '..', 'Public', 'x.txt') })).out
  assert.equal(out.error.code, ERR.PERMISSION_DENIED)
  const pdf = (await call('read_text_file', { path: path.join(root, 'Downloads', 'report.pdf') })).out
  assert.equal(pdf.error.code, ERR.UNSUPPORTED)
})

test('make_folder works inside the roots and is refused outside them', async () => {
  const ok = await call('make_folder', { path: path.join(root, 'Projects', 'New') })
  assert.equal(ok.decision.verdict, 'allow')
  assert.equal(ok.out.result.created, true)
  const bad = await call('make_folder', { path: path.join(root, '..', 'escape') })
  assert.equal(bad.decision.verdict, 'deny')
  assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false)
})

test('bulk moves are previewed for approval; a single move is not', async () => {
  const bulk = await reg.authorize('mcp__jarvis_pc__move_files', {
    from_folder: path.join(root, 'Downloads'),
    pattern: '*.pdf',
    destination_folder: path.join(root, 'PDFs'),
  })
  assert.equal(bulk.verdict, 'confirm')
  assert.match(bulk.summary, /Move 2 files/)
  assert.match(bulk.summary, /report\.pdf/)
  const single = await reg.authorize('mcp__jarvis_pc__move_files', {
    sources: [path.join(root, 'Downloads', 'photo.JPG')],
    destination_folder: path.join(root, 'Pictures'),
  })
  assert.equal(single.verdict, 'allow')
})

test('moves run, skip name clashes unless told, and leave an undo record', async () => {
  touch('Archive/notes.txt', 'older notes')
  const args = { sources: [path.join(root, 'Downloads', 'notes.txt')], destination_folder: path.join(root, 'Archive') }
  const first = (await call('move_files', args)).out.result
  assert.equal(first.moved, 0)
  assert.equal(first.skipped.length, 1)
  assert.equal(fs.readFileSync(path.join(root, 'Archive', 'notes.txt'), 'utf8'), 'older notes')

  const replace = await call('move_files', { ...args, overwrite: true })
  assert.equal(replace.decision.verdict, 'confirm')
  assert.equal(replace.out.result.moved, 1)
  assert.equal(fs.readFileSync(path.join(root, 'Archive', 'notes.txt'), 'utf8'), 'hello world')
  assert.ok(replace.out.result.files[0].backup, 'the replaced file was backed up')
  assert.ok(fs.existsSync(replace.out.result.undo_record))
})

test('copy_file refuses to replace a file unless asked, and backs up when it does', async () => {
  touch('a.txt', 'A')
  touch('b.txt', 'B')
  const clash = (await call('copy_file', { source: path.join(root, 'a.txt'), destination: path.join(root, 'b.txt') })).out
  assert.equal(clash.error.code, ERR.CONFLICT)
  const over = await call('copy_file', { source: path.join(root, 'a.txt'), destination: path.join(root, 'b.txt'), overwrite: true })
  assert.equal(over.decision.verdict, 'confirm')
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'A')
  assert.ok(over.out.result.backup)
})

test('open_path opens documents and folders but never runs a program', { skip: process.platform !== 'win32' }, async () => {
  touch('setup.exe', 'MZ')
  const exe = (await call('open_path', { path: path.join(root, 'setup.exe') })).out
  assert.equal(exe.error.code, ERR.PERMISSION_DENIED)
  launched.length = 0
  const doc = (await call('open_path', { path: path.join(root, 'Documents') })).out
  assert.equal(doc.ok, true)
  assert.deepEqual(launched[0], ['explorer.exe', path.join(root, 'Documents')])
})

test('disk_space and system_stats report real numbers', async () => {
  const d = (await call('disk_space', {})).out.result
  assert.ok(d.drives.length >= 1)
  assert.ok(d.drives[0].total_gb > 0)
  const s = (await call('system_stats', {})).out.result
  assert.ok(s.memory_total_gb > 0)
  assert.ok(s.cpu_percent >= 0 && s.cpu_percent <= 100)
})

test('app matching prefers exact names and reports ambiguity', () => {
  const index = new Map(
    ['Microsoft Word', 'Microsoft Excel', 'Spotify', 'Google Chrome', 'Chrome Remote Desktop'].map((n) => [n.toLowerCase(), { name: n, target: n }]),
  )
  assert.equal(matchApps(index, 'spotify')[0].name, 'Spotify')
  assert.equal(matchApps(index, 'word')[0].name, 'Microsoft Word')
  const microsoft = matchApps(index, 'microsoft')
  assert.equal(microsoft.filter((m) => m.score === microsoft[0].score).length, 2)
  assert.equal(matchApps(index, 'zzz').length, 0)
})

test('tasklist output is parsed', () => {
  const rows = parseTasklist('"chrome.exe","1234","Console","1","123,456 K"\r\n"System","4","Services","0","1,024 K"\r\n')
  assert.deepEqual(rows[0], { name: 'chrome.exe', pid: 1234, memory_kb: 123456 })
  assert.equal(rows.length, 2)
})
