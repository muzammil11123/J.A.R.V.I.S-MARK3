/**
 * Windows desktop control as structured tools.
 *
 * The shell can do all of this too, and still can. These exist because a
 * structured call can be checked properly where a command line can only be
 * pattern-matched: a move tool knows exactly which files it will touch and can
 * show them before it starts, an app launcher only starts things installed in
 * the Start menu, and nothing here ever builds a command string. The persona
 * is told to prefer them.
 *
 * Every path goes through the same lines policy.mjs draws for the built-in
 * file tools: no credentials, no system folders, writes only inside the
 * authorised roots, judged after links are resolved.
 */

import { z } from 'zod'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RISK, normalisePath, isSecretPath, isSystemPath, isWithinRoots } from '../policy.mjs'
import { defineTool, ToolError, ERR, untrusted } from './registry.mjs'

const SERVER = 'jarvis_pc'
const lib = () => (process.platform === 'win32' ? path.win32 : path.posix)

/** Resolve links on the longest part of the path that exists. */
export function realish(p) {
  let head = p
  const tail = []
  for (;;) {
    try {
      return lib().join(fs.realpathSync.native(head), ...tail)
    } catch {
      const parent = lib().dirname(head)
      if (parent === head) return p
      tail.unshift(lib().basename(head))
      head = parent
    }
  }
}

function readable(p, ctx) {
  const full = realish(normalisePath(p, ctx))
  if (isSecretPath(full)) throw new ToolError(ERR.PERMISSION_DENIED, 'That location holds credentials or JARVIS state and is off limits.')
  if (!isWithinRoots(full, { ...ctx, roots: ctx.readRoots ?? ctx.roots })) {
    throw new ToolError(ERR.PERMISSION_DENIED, `${full} is outside the folders JARVIS may read.`)
  }
  return full
}

function writable(p, ctx) {
  const full = readable(p, ctx)
  if (isSystemPath(full)) throw new ToolError(ERR.PERMISSION_DENIED, 'That is a Windows or system folder.')
  if (!isWithinRoots(full, ctx)) throw new ToolError(ERR.PERMISSION_DENIED, `${full} is outside the folders JARVIS may change.`)
  return full
}

/** assess() helper: an unusable path is a refusal, with the reason. */
const denyFrom = (err) => ({ verdict: 'deny', risk: RISK.HIGH, reason: err.message.replace(/\.$/, '').toLowerCase() })

// ---------------------------------------------------------------------------
// Finding files
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information', 'windows',
  'program files', 'program files (x86)', 'programdata', 'appdata', '.cache', '.jarvis',
])

const filterShape = {
  folder: z.string().min(1).optional().describe('Where to look. Defaults to the home folder.'),
  name: z.string().min(1).max(200).optional().describe('Part of the file name, or a pattern with * and ?.'),
  extensions: z.array(z.string().min(1).max(12)).max(20).optional().describe('e.g. ["pdf","docx"]'),
  min_bytes: z.number().int().nonnegative().optional(),
  max_bytes: z.number().int().positive().optional(),
  modified_within_days: z.number().positive().max(36500).optional(),
  modified_before_days: z.number().positive().max(36500).optional(),
}

function nameMatcher(name) {
  if (!name) return () => true
  if (/[*?]/.test(name)) {
    const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    return (n) => re.test(n)
  }
  const needle = name.toLowerCase()
  return (n) => n.toLowerCase().includes(needle)
}

/**
 * Walk a folder and yield matching files. Bounded in entries and time, and
 * says so when it stopped early rather than presenting a partial count as
 * the whole truth.
 */
export async function walk(root, args, { signal, maxEntries = 400_000, budgetMs = 25_000 } = {}) {
  const matchName = nameMatcher(args.name)
  const exts = args.extensions?.map((e) => `.${e.replace(/^\./, '').toLowerCase()}`)
  const now = Date.now()
  const after = args.modified_within_days ? now - args.modified_within_days * 864e5 : -Infinity
  const before = args.modified_before_days ? now - args.modified_before_days * 864e5 : Infinity
  const deadline = now + budgetMs
  const out = []
  let visited = 0
  let truncated = false
  const stack = [root]
  while (stack.length) {
    if (signal?.aborted) throw new ToolError(ERR.CANCELLED, 'Cancelled.')
    if (visited > maxEntries || Date.now() > deadline) {
      truncated = true
      break
    }
    const dir = stack.pop()
    let handle
    try {
      handle = await fsp.opendir(dir)
    } catch {
      continue
    }
    for await (const ent of handle) {
      visited++
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name.toLowerCase()) && !isSecretPath(full + path.sep)) stack.push(full)
        continue
      }
      if (!ent.isFile()) continue
      if (!matchName(ent.name)) continue
      if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue
      if (isSecretPath(full)) continue
      let st
      try {
        st = await fsp.stat(full)
      } catch {
        continue
      }
      if (args.min_bytes != null && st.size < args.min_bytes) continue
      if (args.max_bytes != null && st.size > args.max_bytes) continue
      if (st.mtimeMs < after || st.mtimeMs > before) continue
      out.push({ path: full, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() })
    }
  }
  return { files: out, visited, truncated }
}

// ---------------------------------------------------------------------------
// Moving files
// ---------------------------------------------------------------------------

/** Exactly which files a move will touch, worked out before it starts. */
export async function planMove(args, ctx) {
  const dest = writable(args.destination_folder, ctx)
  let sources
  if (args.sources?.length) {
    sources = args.sources.map((s) => writable(s, ctx))
  } else if (args.from_folder && args.pattern) {
    const from = writable(args.from_folder, ctx)
    const match = nameMatcher(args.pattern)
    const ents = await fsp.readdir(from, { withFileTypes: true }).catch(() => {
      throw new ToolError(ERR.NOT_FOUND, `${from} does not exist.`)
    })
    sources = ents.filter((e) => e.isFile() && match(e.name)).map((e) => path.join(from, e.name))
  } else {
    throw new ToolError(ERR.INVALID_ARGS, 'Give either sources, or from_folder with pattern.')
  }
  return sources.map((from) => {
    const to = path.join(dest, path.basename(from))
    return { from, to, overwrites: fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase() }
  })
}

function describeMove(plan, dest) {
  const head = plan.slice(0, 12).map((m) => `  ${path.basename(m.from)}${m.overwrites ? '  (replaces existing)' : ''}`)
  const more = plan.length > 12 ? [`  …and ${plan.length - 12} more`] : []
  return [`Move ${plan.length} file${plan.length === 1 ? '' : 's'} to ${dest}:`, ...head, ...more].join('\n')
}

async function moveOne(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fsp.copyFile(from, to)
    await fsp.unlink(from)
  }
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** Windows built-ins that have no Start-menu shortcut of their own. */
const BUILTIN_APPS = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  paint: 'mspaint.exe',
  'file explorer': 'explorer.exe',
  'task manager': 'taskmgr.exe',
  settings: 'ms-settings:',
  'snipping tool': 'ms-screenclip:',
}

/** Everything in the Start menu, by display name. Rebuilt every few minutes. */
let appIndex = null
let appIndexAt = 0
async function startMenuApps() {
  if (appIndex && Date.now() - appIndexAt < 5 * 60_000) return appIndex
  const roots = [
    path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ]
  const found = new Map()
  for (const root of roots) {
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) {
          const name = e.name.replace(/\.(lnk|url|appref-ms)$/i, '')
          if (/uninstall|readme|help|documentation|license|release notes/i.test(name)) continue
          if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, target: full })
        }
      }
    }
  }
  for (const [name, target] of Object.entries(BUILTIN_APPS)) {
    if (!found.has(name)) found.set(name, { name, target })
  }
  appIndex = found
  appIndexAt = Date.now()
  return found
}

/** Best matches for a spoken app name: exact, then prefix, then word, then substring. */
export function matchApps(index, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim()
  const scored = []
  for (const [key, app] of index) {
    const k = key.replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim()
    const score = k === q ? 4 : k.startsWith(q) ? 3 : k.split(' ').includes(q) ? 2 : k.includes(q) ? 1 : 0
    if (score) scored.push({ ...app, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return scored
}

/** Files that run code when "opened". Opening is for documents. */
const EXECUTABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|hta|cpl|jar|reg|lnk|appref-ms|sh)$/i

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|ya?ml|ini|cfg|conf|toml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sql|sh|ps1|bat|srt|vtt|rtf)$/i

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** @param {{ run: typeof import('./exec.mjs').run, backup?: (file: string) => string|null, stateDir?: string }} deps */
export function desktopTools({ run, backup = () => null, stateDir = path.join(os.homedir(), '.jarvis') }) {
  const windowsOnly = () => {
    if (process.platform !== 'win32') throw new ToolError(ERR.UNSUPPORTED, 'This works on Windows only.')
  }

  return [
    defineTool({
      server: SERVER,
      name: 'find_files',
      description:
        'Find files by name, extension, size and modification time. Read only. ' +
        'Prefer this to a shell command for any file search.',
      input: {
        ...filterShape,
        sort: z.enum(['modified', 'size', 'name']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      risk: RISK.READ,
      permissions: ['files:read'],
      timeoutMs: 40_000,
      async run(args, { ctx, signal }) {
        const root = readable(args.folder ?? ctx.home, ctx)
        const { files, visited, truncated } = await walk(root, args, { signal })
        const by = args.sort ?? 'modified'
        files.sort((a, b) =>
          by === 'size' ? b.bytes - a.bytes : by === 'name' ? a.path.localeCompare(b.path) : b.modified.localeCompare(a.modified),
        )
        const limit = args.limit ?? 50
        return { folder: root, total: files.length, shown: Math.min(limit, files.length), files: files.slice(0, limit), searched_entries: visited, truncated }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'count_files',
      description: 'Count files matching the same filters as find_files, with their total size. Read only.',
      input: filterShape,
      risk: RISK.READ,
      permissions: ['files:read'],
      timeoutMs: 40_000,
      async run(args, { ctx, signal }) {
        const root = readable(args.folder ?? ctx.home, ctx)
        const { files, truncated } = await walk(root, args, { signal })
        return { folder: root, count: files.length, total_bytes: files.reduce((n, f) => n + f.bytes, 0), truncated }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'read_text_file',
      description: 'Read a plain-text file (txt, md, csv, json, code, logs). For PDFs and images use the Read tool. Read only.',
      input: { path: z.string().min(1), max_bytes: z.number().int().min(1).max(1_000_000).optional() },
      risk: RISK.READ,
      permissions: ['files:read'],
      async run(args, { ctx }) {
        const full = readable(args.path, ctx)
        if (!TEXT_EXT.test(full)) throw new ToolError(ERR.UNSUPPORTED, 'Not a plain-text file. Use the Read tool for PDFs, images and notebooks.')
        const st = await fsp.stat(full).catch(() => null)
        if (!st?.isFile()) throw new ToolError(ERR.NOT_FOUND, `${full} does not exist.`)
        const max = args.max_bytes ?? 200_000
        const fh = await fsp.open(full, 'r')
        try {
          const buf = Buffer.alloc(Math.min(max, st.size))
          await fh.read(buf, 0, buf.length, 0)
          return { path: full, bytes: st.size, truncated: st.size > max, ...untrusted(`file ${full}`, buf.toString('utf8')) }
        } finally {
          await fh.close()
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'pdf_info',
      description: 'Page count, title and size of a PDF. To read its text, use the Read tool on the same path.',
      input: { path: z.string().min(1) },
      risk: RISK.READ,
      permissions: ['files:read'],
      async run(args, { ctx }) {
        const full = readable(args.path, ctx)
        if (!/\.pdf$/i.test(full)) throw new ToolError(ERR.INVALID_ARGS, 'Not a PDF.')
        const st = await fsp.stat(full).catch(() => null)
        if (!st?.isFile()) throw new ToolError(ERR.NOT_FOUND, `${full} does not exist.`)
        const raw = (await fsp.readFile(full)).subarray(0, 60 * 1024 * 1024).toString('latin1')
        const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
        const title = /\/Title\s*\(([^)]{1,200})\)/.exec(raw)?.[1] ?? null
        return { path: full, bytes: st.size, pages: pages || null, title, encrypted: /\/Encrypt\b/.test(raw), read_with: 'Read tool' }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'make_folder',
      description: 'Create a folder (and any missing parents) inside the authorised folders.',
      input: { path: z.string().min(1) },
      risk: RISK.REVERSIBLE,
      permissions: ['files:write'],
      assess(args, ctx) {
        try {
          writable(args.path, ctx)
          return null
        } catch (err) {
          return denyFrom(err)
        }
      },
      async run(args, { ctx }) {
        const full = writable(args.path, ctx)
        const existed = fs.existsSync(full)
        await fsp.mkdir(full, { recursive: true })
        return { path: full, created: !existed }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'move_files',
      description:
        'Move files into a folder: either a list of sources, or every file in from_folder matching pattern (e.g. "*.pdf"). ' +
        'More than one file, or replacing an existing file, is shown to the user for approval first. ' +
        'An undo record is kept.',
      input: {
        destination_folder: z.string().min(1),
        sources: z.array(z.string().min(1)).min(1).max(1000).optional(),
        from_folder: z.string().min(1).optional(),
        pattern: z.string().min(1).max(200).optional(),
        overwrite: z.boolean().optional(),
      },
      risk: RISK.REVERSIBLE,
      permissions: ['files:write'],
      timeoutMs: 120_000,
      async assess(args, ctx) {
        let plan
        try {
          plan = await planMove(args, ctx)
        } catch (err) {
          return denyFrom(err)
        }
        if (!plan.length) return { verdict: 'allow', risk: RISK.READ, reason: 'matches no files', summary: 'nothing to move' }
        const replacing = args.overwrite && plan.some((m) => m.overwrites)
        if (plan.length > 1 || replacing) {
          return {
            verdict: 'confirm',
            risk: RISK.DESTRUCTIVE,
            reason: replacing ? 'moves files and replaces existing ones' : `moves ${plan.length} files at once`,
            summary: describeMove(plan, writable(args.destination_folder, ctx)),
          }
        }
        return { verdict: 'allow', risk: RISK.REVERSIBLE, reason: 'moves one file', summary: describeMove(plan, writable(args.destination_folder, ctx)) }
      },
      async run(args, { ctx, signal, progress }) {
        const plan = await planMove(args, ctx)
        const dest = writable(args.destination_folder, ctx)
        await fsp.mkdir(dest, { recursive: true })
        const moved = []
        const skipped = []
        const failed = []
        for (const [i, m] of plan.entries()) {
          if (signal.aborted) break
          if (m.overwrites && !args.overwrite) {
            skipped.push({ from: m.from, reason: 'a file with that name already exists (set overwrite to replace it)' })
            continue
          }
          try {
            const saved = m.overwrites ? backup(m.to) : null
            await moveOne(m.from, m.to)
            moved.push({ from: m.from, to: m.to, ...(saved ? { backup: saved } : {}) })
          } catch (err) {
            failed.push({ from: m.from, error: err.code ?? err.message })
          }
          if (plan.length > 20 && i % 20 === 19) progress(`${i + 1} of ${plan.length}`)
        }
        let undo = null
        if (moved.length) {
          const dir = path.join(stateDir, 'undo')
          await fsp.mkdir(dir, { recursive: true })
          undo = path.join(dir, `move-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          await fsp.writeFile(undo, JSON.stringify({ kind: 'move', moved }, null, 2))
        }
        return {
          moved: moved.length,
          skipped,
          failed,
          cancelled: signal.aborted && moved.length + skipped.length + failed.length < plan.length,
          complete: !failed.length && moved.length + skipped.length === plan.length,
          files: moved.slice(0, 50),
          undo_record: undo,
        }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'copy_file',
      description: 'Copy one file. Replacing an existing file needs overwrite=true, is approved by the user first, and the old copy is backed up.',
      input: { source: z.string().min(1), destination: z.string().min(1), overwrite: z.boolean().optional() },
      risk: RISK.REVERSIBLE,
      permissions: ['files:write'],
      timeoutMs: 120_000,
      assess(args, ctx) {
        let to
        try {
          readable(args.source, ctx)
          to = writable(args.destination, ctx)
        } catch (err) {
          return denyFrom(err)
        }
        if (fs.existsSync(to) && args.overwrite) {
          return { verdict: 'confirm', risk: RISK.DESTRUCTIVE, reason: 'replaces an existing file (a backup is kept)', summary: `${args.source}\n  → ${to}` }
        }
        return null
      },
      async run(args, { ctx }) {
        const from = readable(args.source, ctx)
        let to = writable(args.destination, ctx)
        if (fs.statSync(to, { throwIfNoEntry: false })?.isDirectory()) to = path.join(to, path.basename(from))
        const exists = fs.existsSync(to)
        if (exists && !args.overwrite) throw new ToolError(ERR.CONFLICT, `${to} already exists. Ask the user whether to replace it.`)
        const saved = exists ? backup(to) : null
        await fsp.copyFile(from, to, exists ? 0 : fs.constants.COPYFILE_EXCL)
        return { from, to, replaced: exists, ...(saved ? { backup: saved } : {}) }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'open_app',
      description:
        'Open an installed application by name (from the Start menu, e.g. "Spotify", "Word", "Chrome"). ' +
        'Only installed apps can be opened; if several match, the candidates come back instead.',
      input: { name: z.string().min(1).max(100) },
      risk: RISK.REVERSIBLE,
      permissions: ['apps:launch'],
      async run(args, { signal }) {
        windowsOnly()
        const matches = matchApps(await startMenuApps(), args.name)
        if (!matches.length) throw new ToolError(ERR.NOT_FOUND, `No installed app called "${args.name}".`)
        const best = matches.filter((m) => m.score === matches[0].score)
        const distinct = [...new Set(best.map((m) => m.name.toLowerCase()))]
        if (distinct.length > 1 && matches[0].score < 4) {
          throw new ToolError(ERR.AMBIGUOUS, `Several apps match "${args.name}".`, { details: { candidates: best.slice(0, 8).map((m) => m.name) } })
        }
        const app = matches[0]
        await run('explorer.exe', [app.target], { signal, timeoutMs: 10_000 })
        return { opened: app.name }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'open_path',
      description: 'Show a folder in File Explorer, or open a document in its default app. Programs and scripts are refused; use open_app.',
      input: { path: z.string().min(1) },
      risk: RISK.REVERSIBLE,
      permissions: ['files:read', 'apps:launch'],
      async run(args, { ctx, signal }) {
        windowsOnly()
        const full = readable(args.path, ctx)
        const st = fs.statSync(full, { throwIfNoEntry: false })
        if (!st) throw new ToolError(ERR.NOT_FOUND, `${full} does not exist.`)
        if (st.isFile() && EXECUTABLE.test(full)) {
          throw new ToolError(ERR.PERMISSION_DENIED, 'That file is a program or script. Opening it would run it, which this tool does not do.')
        }
        await run('explorer.exe', [full], { signal, timeoutMs: 10_000 })
        return { opened: full, kind: st.isDirectory() ? 'folder' : 'file' }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'disk_space',
      description: 'Free and total space on each drive. Read only.',
      input: {},
      risk: RISK.READ,
      async run(_args, { ctx }) {
        const roots = new Set(
          (ctx.readRoots ?? ctx.roots).map((r) => (process.platform === 'win32' ? `${r.slice(0, 2).toUpperCase()}\\` : '/')),
        )
        const drives = []
        for (const root of roots) {
          try {
            const s = await fsp.statfs(root)
            const total = s.blocks * s.bsize
            const free = s.bavail * s.bsize
            drives.push({ drive: root, total_gb: +(total / 1e9).toFixed(1), free_gb: +(free / 1e9).toFixed(1), used_percent: total ? Math.round((1 - free / total) * 100) : null })
          } catch {
            /* not a mounted drive */
          }
        }
        return { drives }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'system_stats',
      description: 'CPU load, memory use and uptime of this PC. Read only.',
      input: {},
      risk: RISK.READ,
      async run() {
        return systemStats()
      },
    }),

    defineTool({
      server: SERVER,
      name: 'list_processes',
      description: 'Running programs with their memory use, biggest first. Read only. Stopping one still needs a shell command and approval.',
      input: { limit: z.number().int().min(1).max(200).optional(), name: z.string().min(1).max(100).optional() },
      risk: RISK.READ,
      retries: 1,
      async run(args, { signal }) {
        windowsOnly()
        const { stdout } = await run('tasklist', ['/fo', 'csv', '/nh'], { signal })
        const rows = parseTasklist(stdout)
        const filtered = args.name ? rows.filter((r) => r.name.toLowerCase().includes(args.name.toLowerCase())) : rows
        // One program is often many processes; group them so "Chrome" is one line.
        const groups = new Map()
        for (const r of filtered) {
          const g = groups.get(r.name) ?? { name: r.name, processes: 0, memory_mb: 0 }
          g.processes++
          g.memory_mb += r.memory_kb / 1024
          groups.set(r.name, g)
        }
        const list = [...groups.values()].map((g) => ({ ...g, memory_mb: Math.round(g.memory_mb) })).sort((a, b) => b.memory_mb - a.memory_mb)
        return { programs: list.slice(0, args.limit ?? 15), total_processes: filtered.length }
      },
    }),

    defineTool({
      server: SERVER,
      name: 'screenshot',
      description:
        'Capture the whole screen to a PNG in Pictures\\JARVIS and return its path. To see what is on it, use the Read tool on that path.',
      input: {},
      risk: RISK.REVERSIBLE,
      permissions: ['screen:capture', 'files:write'],
      timeoutMs: 60_000,
      async run(_args, { ctx, signal }) {
        windowsOnly()
        const dir = path.join(ctx.home, 'Pictures', 'JARVIS')
        await fsp.mkdir(dir, { recursive: true })
        const file = path.join(dir, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        // The path is ours, built above — nothing from the model reaches this script.
        const script =
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
          '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;' +
          '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;' +
          '$g=[System.Drawing.Graphics]::FromImage($bmp);' +
          '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);' +
          `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);` +
          '$g.Dispose();$bmp.Dispose()'
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { signal, timeoutMs: 55_000 })
        if (!fs.existsSync(file)) throw new ToolError(ERR.FAILED, 'The screen could not be captured.')
        return { path: file, next: 'Use the Read tool on this path to look at it.' }
      },
    }),
  ]
}

/** `"chrome.exe","1234","Console","1","123,456 K"` → rows. */
export function parseTasklist(csv) {
  const rows = []
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1])
    if (cells.length < 5) continue
    rows.push({ name: cells[0], pid: Number(cells[1]), memory_kb: Number(cells[4].replace(/[^\d]/g, '')) || 0 })
  }
  return rows
}

/** CPU over a short sample, plus memory and uptime. Shared with /status. */
export async function systemStats(sampleMs = 400) {
  const snap = () => os.cpus().map((c) => c.times)
  const a = snap()
  await new Promise((r) => setTimeout(r, sampleMs))
  const b = snap()
  let idle = 0
  let total = 0
  b.forEach((t, i) => {
    const p = a[i]
    const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq
    idle += t.idle - p.idle
    total += sum(t) - sum(p)
  })
  const mem = { total: os.totalmem(), free: os.freemem() }
  return {
    cpu_percent: total ? Math.round((1 - idle / total) * 100) : null,
    cores: os.cpus().length,
    memory_used_gb: +((mem.total - mem.free) / 1e9).toFixed(1),
    memory_total_gb: +(mem.total / 1e9).toFixed(1),
    memory_percent: Math.round((1 - mem.free / mem.total) * 100),
    uptime_hours: +(os.uptime() / 3600).toFixed(1),
  }
}
