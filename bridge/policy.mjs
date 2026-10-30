/**
 * What JARVIS may do with what it was asked, decided per call.
 *
 * decideTool() in server.mjs answers a coarse question — is this *kind* of
 * tool allowed at all — from the tool's name alone. That is enough in
 * read-only mode, where every effectful tool is simply off. With writes on it
 * is not: `Bash` is one name for both `ls` and `rm -rf ~`, and a voice
 * assistant has no dialog box to catch the difference. This module reads the
 * call's input and sorts it into one of three outcomes:
 *
 *   allow   — reads, launching apps, creating new files and folders.
 *   confirm — anything that deletes, overwrites, kills, installs, elevates,
 *             changes system settings or sends something out. The person
 *             approves it on screen before it runs.
 *   deny    — never, whatever anyone approves: wiping disks, disabling the
 *             security tools, download-and-execute, obfuscated commands, and
 *             anything that touches stored credentials.
 *
 * It is a pure function of (tool, input, context) so it can be tested without
 * a model in the loop. It is a guard rail, not a sandbox: a shell is
 * Turing-complete and a determined command can be phrased past any pattern
 * list. The patterns err towards asking, and the hard denials are for things
 * that are catastrophic or that nothing JARVIS is for ever needs.
 */

import path from 'node:path'

export const RISK = /** @type {const} */ ({
  READ: 'read',
  REVERSIBLE: 'reversible',
  COMMUNICATION: 'communication',
  DESTRUCTIVE: 'destructive',
  HIGH: 'high',
})

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WRITE_FILE_TOOLS = new Set(['Write'])
const EDIT_FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/**
 * Files no request ever needs JARVIS to open, let alone change: keys, tokens,
 * saved browser passwords. Reading them is the first half of exfiltration, and
 * a web page the model has just read can ask for exactly that.
 */
const SECRET_PATH =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)([\\/]|$)|[\\/]\.claude[\\/]\.credentials\.json|(^|[\\/])\.claude\.json$|(^|[\\/])\.env(\.[\w-]+)?$|(^|[\\/])\.npmrc$|(^|[\\/])\.git-credentials$|[\\/](Login Data|Cookies|Web Data)$|[\\/]Microsoft[\\/](Credentials|Protect|Vault)([\\/]|$)|[\\/]\.jarvis[\\/]/i

/** The same list, phrased to be found anywhere inside a shell command. */
const SECRET_IN_COMMAND =
  /\.ssh\b|\.gnupg\b|\.aws[\\/]|\.azure[\\/]|\.kube[\\/]|\.docker[\\/]config|\.credentials\.json|\.claude\.json|(^|[\s'"\\/])\.env(\.[\w-]+)?\b|\.npmrc\b|\.git-credentials|Login Data|Microsoft[\\/](Credentials|Protect|Vault)|\.jarvis[\\/]|cmdkey|vaultcmd|Get-StoredCredential|ConvertFrom-SecureString|mimikatz|sekurlsa|lsass/i

/** Places where a change can stop the machine booting. */
const SYSTEM_PATH =
  /^([a-z]:[\\/](windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information|boot|recovery)([\\/]|$))|^\/(etc|bin|sbin|usr|boot|system|library|private)(\/|$)/i
const SYSTEM_IN_COMMAND =
  /[a-z]:[\\/](windows|program files|programdata)\b|\/[a-z]\/(windows|program files|programdata)\b|\\windows\\system32|\/(etc|boot|sbin)\//i

/**
 * Hard denials. Each is something catastrophic, or a technique whose only
 * purpose is to hide what a command does — and hiding it from this check is
 * exactly what an injected instruction would want.
 */
const NEVER = [
  [/\bformat(\.com)?\s+[a-z]:|\bFormat-Volume\b|\bClear-Disk\b|\bInitialize-Disk\b|\bdiskpart\b|\bmkfs(\.\w+)?\b|\bdd\b[^|;&]*\bof=\/dev\//i, 'formats or wipes a disk'],
  [/\bbcdedit\b|\bbootrec\b|\bvssadmin\b[^|;&]*\bdelete\b|\bwbadmin\b[^|;&]*\bdelete\b|\bcipher\b[^|;&]*\/w\b/i, 'changes boot configuration or destroys backups'],
  [/\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, 'runs an encoded, unreadable command'],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(ba|z|da)?sh\b|\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\b[^;&]*(DownloadString|DownloadData|Net\.WebClient|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b)/i, 'downloads code and runs it'],
  [/\bSet-MpPreference\b[^|;&]*-Disable|\bAdd-MpPreference\b[^|;&]*-Exclusion|\bnetsh\b[^|;&]*\bfirewall\b[^|;&]*\b(off|disable)|\bSet-NetFirewallProfile\b[^|;&]*-Enabled\s+(False|\$false|0)/i, 'disables security protections'],
  [/\bwevtutil\b[^|;&]*\bcl\b|\bClear-EventLog\b|\bRemove-EventLog\b/i, 'erases system logs'],
  // Text piped straight into an interpreter is a script nobody has read, and
  // caret and backtick escapes inside a word exist only to dodge a check like
  // this one: `d^el`, `Re`move-Item`.
  [/\|\s*(ba|z|da|k)?sh\b(?![\w.-])|\|\s*(powershell|pwsh|cmd)(\.exe)?\b|\|\s*(python3?|node|perl|ruby)\b\s*(-\s*)?$/i, 'pipes text into a shell to run'],
  [/[a-z]\^[a-z]|[a-z]`[a-z]/i, 'hides a command behind escape characters'],
  [/\b(rm|del|erase|rd|rmdir|Remove-Item|ri)\b[^|;&]*\s(['"]?)(\/|~|~\/|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[a-z]:[\\/]?|\/[a-z]\/?|\/[a-z]\/Users\/[^\\/\s'"]+\/?|[a-z]:[\\/]Users[\\/][^\\/\s'"]+[\\/]?)\2(\s|$|\*)/i, 'deletes a whole drive or home folder'],
]

/** Each of these runs only after the person approves it. */
const CONFIRM = [
  [/\b(rm|rmdir|unlink|shred|del|erase|rd|Remove-Item|ri|Clear-Content|Clear-Item|Clear-RecycleBin|truncate)\b|\s-delete\b|\bNew-Item\b(?![^|;&]*-ItemType\s+['"]?Directory)[^|;&]*-Force\b|\brobocopy\b[^|;&]*\/(MIR|PURGE)\b/i, RISK.DESTRUCTIVE, 'deletes files'],
  // Deleting and overwriting through a language runtime rather than a shell
  // verb. Without these, `python -c "shutil.rmtree(...)"` or
  // `[IO.File]::Delete(...)` walks straight past every rule above.
  [/::(Delete|WriteAll(Text|Bytes|Lines)|Move|Replace|Copy)\s*\(|\.Delete\s*\(|\b(rmtree|rmSync|rmdirSync|unlinkSync|writeFileSync|os\.remove|os\.unlink|os\.rmdir|shutil\.move|send2trash)\b/i, RISK.DESTRUCTIVE, 'deletes or overwrites files from inside a script'],
  // Code assembled or evaluated at run time: what it does cannot be read from
  // the command, so the person reads it instead. A nested `powershell -c "..."`
  // is not on this list: its text is literal and every rule here reads it.
  [/\b(eval|iex|Invoke-Expression|Invoke-Command|icm)\b|\[scriptblock\]::Create|(?:^|[;|(]\s*|\s)&\s*[($]|\b(python3?|py|node|perl|ruby|php|deno|bun|wscript|cscript|mshta)(\.exe)?\b[^|;&]*\s(-c|-e|--eval|-p|--print)\b|\b(powershell|pwsh)(\.exe)?\b[^|;&]*\s-File\b/i, RISK.HIGH, 'runs script code generated on the fly'],
  [/\bmklink\b|\bln\s+-\w*s|\bNew-Item\b[^|;&]*-ItemType\s+['"]?(SymbolicLink|Junction|HardLink)/i, RISK.HIGH, 'creates a link that redirects to another location'],
  [/\b(kill|pkill|killall|taskkill|Stop-Process|spps)\b/i, RISK.DESTRUCTIVE, 'stops running programs'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|logoff|Suspend-Computer)\b|rundll32[^|;&]*(SetSuspendState|LockWorkStation)/i, RISK.HIGH, 'shuts down, restarts or signs out'],
  [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)\b|\b(Set|New|Remove|Rename)-ItemProperty\b|\b(New|Remove|Set)-Item\b[^|;&]*\bHK(LM|CU|CR|U|CC):/i, RISK.HIGH, 'changes the Windows registry'],
  [/\b(winget|choco|scoop)\s+(install|uninstall|upgrade|remove)\b|\bmsiexec\b|\b(Install|Uninstall|Update)-(Package|Module|Script)\b|\bnpm\s+(i|install|uninstall|rm|remove|update)\b[^|;&]*\s-g\b|\bpip3?\s+(install|uninstall)\b|\bapt(-get)?\s+(install|remove|purge)\b|\bbrew\s+(install|uninstall)\b/i, RISK.HIGH, 'installs or removes software'],
  [/\b(sudo|runas|gsudo)\b|-Verb\s+['"]?RunAs/i, RISK.HIGH, 'runs with administrator rights'],
  [/\bSet-ExecutionPolicy\b|\bnetsh\b|\bsc(\.exe)?\s+(config|delete|create|stop|start)\b|\b(Set|Stop|Start|Restart|New|Remove)-Service\b|\bschtasks\b[^|;&]*\/(create|delete|change)|\b(Register|Unregister)-ScheduledTask\b|\bnet\s+(user|localgroup|share|stop|start)\b|\b(icacls|takeown|cacls)\b|\battrib\b[^|;&]*[+-][shr]\b|\b(Enable|Disable)-(NetAdapter|ComputerRestore|WindowsOptionalFeature)\b|\bpowercfg\b[^|;&]*\/(change|setactive|hibernate)/i, RISK.HIGH, 'changes system settings'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch)\b/i, RISK.DESTRUCTIVE, 'rewrites or publishes git history'],
  [/\bSend-MailMessage\b|\bcurl\b[^|;&]*\s(-d|--data(-\w+)?|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))\b|\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;&]*-Method\s+['"]?(Post|Put|Patch|Delete)|\bwget\b[^|;&]*--post-(data|file)|\bscp\b|\brsync\b[^|;&]*:\S|\bftp\b|\bsftp\b/i, RISK.COMMUNICATION, 'sends data off this machine'],
]

/**
 * Bulk moves and renames: reversible one at a time, but a wildcard or a loop
 * turns one misheard word into a hundred changed files. These are the cases
 * the brief calls "destructive bulk changes", and the approval prompt shows the
 * exact command as the preview.
 */
const MOVE = /\b(mv|move|Move-Item|mi|ren|rename|Rename-Item|rni|robocopy)\b/i
const BULK = /[*?]|\bforeach\b|\bfor\s|\bForEach-Object\b|\s%\s|\bxargs\b|-Recurse\b|\/MIR\b|\/MOV\b/i

/**
 * Output redirection that can replace an existing file. `>>` appends and is
 * left alone; so are the redirects that only discard (`> /dev/null`, `2>&1`).
 */
function overwriteTargets(command) {
  const targets = []
  const re = /(^|[^>&\d])>\s*(?!>|&)("([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g
  let m
  while ((m = re.exec(command))) {
    const target = m[3] ?? m[4] ?? m[5]
    if (!target || /^(\/dev\/null|nul|\$null)$/i.test(target)) continue
    targets.push(target)
  }
  // PowerShell's own writers, which replace a file unless told to append.
  const ps = /\b(Set-Content|Out-File|sc)\b(?![^|;&]*-Append)[^|;&]*?(?:-(?:Path|FilePath|LiteralPath)\s+)?("([^"]+)"|'([^']+)'|([^\s;&|-][^\s;&|]*))/gi
  while ((m = ps.exec(command))) {
    const target = m[3] ?? m[4] ?? m[5]
    if (target) targets.push(target)
  }
  // tee replaces its file too, unless it is told to append.
  const tee = /\btee\b(?![^|;&]*\s-a\b)(?:\s+-\w+)*\s+("([^"]+)"|'([^']+)'|([^\s;&|<>-][^\s;&|<>]*))/gi
  while ((m = tee.exec(command))) {
    const target = m[2] ?? m[3] ?? m[4]
    if (target) targets.push(target)
  }
  return targets
}

/**
 * The destination of a copy or move, when it is a file that already exists.
 * A copy onto an existing name, or a move onto one, replaces it without a
 * word — the same loss as an overwrite, by another verb.
 */
const COPY_OR_MOVE = /\b(cp|copy|Copy-Item|cpi|xcopy|mv|move|Move-Item|mi)\b([^|;&]*)/gi
function replacedByCopyOrMove(command, ctx) {
  const hits = []
  let m
  while ((m = COPY_OR_MOVE.exec(command))) {
    const words = [...m[2].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)]
      .map((w) => w[1] ?? w[2] ?? w[3])
      .filter((w) => !/^(-|\/[A-Za-z]{1,2}$)/.test(w))
    if (words.length < 2) continue
    const dest = normalisePath(words[words.length - 1], ctx)
    // A system folder is refused whether or not the name exists yet.
    if (SYSTEM_PATH.test(dest) || (ctx.isFile ?? ctx.exists)(dest)) hits.push(dest)
  }
  return hits
}

/**
 * Git Bash and PowerShell spell the same file differently. `/c/Users/x` and
 * `C:\Users\x` and `~/x` all have to land on one absolute path before they can
 * be compared with anything.
 */
export function normalisePath(p, ctx) {
  const win = ctx.platform === 'win32'
  const lib = win ? path.win32 : path.posix
  let s = String(p).trim().replace(/^['"]|['"]$/g, '')
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = lib.join(ctx.home, s.slice(1))
  s = s.replace(/^\$HOME\b|^\$env:USERPROFILE\b|^%USERPROFILE%/i, ctx.home)
  if (win) {
    const drive = /^\/([a-z])(\/|$)/i.exec(s)
    if (drive) s = `${drive[1].toUpperCase()}:\\${s.slice(drive[0].length)}`
  }
  return lib.resolve(ctx.cwd ?? ctx.home, s)
}

function within(child, root, ctx) {
  const lib = ctx.platform === 'win32' ? path.win32 : path.posix
  const rel = lib.relative(root, child)
  if (rel === '') return true
  const out = rel.startsWith('..') || lib.isAbsolute(rel)
  return !out
}

/** The paths a file tool says it will touch. */
function filePathsOf(input) {
  if (!input || typeof input !== 'object') return []
  return ['file_path', 'notebook_path', 'path']
    .map((k) => input[k])
    .filter((v) => typeof v === 'string' && v.length)
}

function summariseCommand(command) {
  const one = command.replace(/\s+/g, ' ').trim()
  return one.length > 240 ? `${one.slice(0, 237)}...` : one
}

/**
 * The verdict for one tool call.
 *
 * @param {string} tool  the SDK's tool name, e.g. Bash, Write, mcp__x__y
 * @param {unknown} input the arguments the model chose
 * @param {{ platform: string, home: string, cwd?: string, roots: string[],
 *           exists: (p: string) => boolean }} ctx
 * @returns {{ verdict: 'allow'|'confirm'|'deny', risk: string, reason: string,
 *             summary: string, backup?: string }}
 */
export function assess(tool, input, ctx) {
  const args = input && typeof input === 'object' ? input : {}

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof args.command === 'string' ? args.command : ''
    const summary = summariseCommand(command)
    if (!command.trim()) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'empty command', summary }
    }
    for (const [re, reason] of NEVER) {
      if (re.test(command)) return { verdict: 'deny', risk: RISK.HIGH, reason, summary }
    }
    if (SECRET_IN_COMMAND.test(command)) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'touches stored credentials or keys', summary }
    }
    const destructiveHere = CONFIRM.some(([re, risk]) => risk !== RISK.COMMUNICATION && re.test(command))
    if (destructiveHere && SYSTEM_IN_COMMAND.test(command)) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'changes a Windows or system folder', summary }
    }
    for (const [re, risk, reason] of CONFIRM) {
      if (re.test(command)) return { verdict: 'confirm', risk, reason, summary }
    }
    for (const dest of replacedByCopyOrMove(command, ctx)) {
      if (SYSTEM_PATH.test(dest)) {
        return { verdict: 'deny', risk: RISK.HIGH, reason: 'writes into a Windows or system folder', summary }
      }
      return { verdict: 'confirm', risk: RISK.DESTRUCTIVE, reason: 'replaces an existing file', summary }
    }
    if (MOVE.test(command) && BULK.test(command)) {
      return { verdict: 'confirm', risk: RISK.DESTRUCTIVE, reason: 'moves or renames many files at once', summary }
    }
    for (const target of overwriteTargets(command)) {
      const full = normalisePath(target, ctx)
      if (SYSTEM_PATH.test(full)) {
        return { verdict: 'deny', risk: RISK.HIGH, reason: 'writes into a Windows or system folder', summary }
      }
      if (ctx.exists(full)) {
        return { verdict: 'confirm', risk: RISK.DESTRUCTIVE, reason: 'overwrites an existing file', summary }
      }
    }
    if (MOVE.test(command)) {
      return { verdict: 'allow', risk: RISK.REVERSIBLE, reason: 'moves or renames a file', summary }
    }
    return { verdict: 'allow', risk: RISK.READ, reason: 'no destructive operation found', summary }
  }

  // Through any links, when the caller can resolve them: a path inside the
  // home folder that is really a junction into C:\Windows is C:\Windows.
  const paths = filePathsOf(args).map((p) => {
    const full = normalisePath(p, ctx)
    return ctx.real ? ctx.real(full) : full
  })

  if (READ_FILE_TOOLS.has(tool)) {
    const summary = paths[0] ?? String(args.pattern ?? '')
    if (paths.some((p) => SECRET_PATH.test(p))) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'reads stored credentials or keys', summary }
    }
    return { verdict: 'allow', risk: RISK.READ, reason: 'read only', summary }
  }

  if (WRITE_FILE_TOOLS.has(tool) || EDIT_FILE_TOOLS.has(tool)) {
    const target = paths[0]
    const summary = target ?? '(no path)'
    if (!target) return { verdict: 'deny', risk: RISK.HIGH, reason: 'no file path given', summary }
    if (SECRET_PATH.test(target)) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'writes to stored credentials or keys', summary }
    }
    if (SYSTEM_PATH.test(target)) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'writes into a Windows or system folder', summary }
    }
    if (!ctx.roots.some((root) => within(target, root, ctx))) {
      return { verdict: 'deny', risk: RISK.HIGH, reason: 'is outside the folders JARVIS is allowed to change', summary }
    }
    const exists = ctx.exists(target)
    if (WRITE_FILE_TOOLS.has(tool) && exists) {
      return { verdict: 'confirm', risk: RISK.DESTRUCTIVE, reason: 'overwrites an existing file', summary, backup: target }
    }
    // An edit changes part of a file the person can still recognise, and a
    // copy is taken first — reversible, so it runs without stopping to ask.
    return {
      verdict: 'allow',
      risk: RISK.REVERSIBLE,
      reason: exists ? 'edits a file (a backup is kept)' : 'creates a new file',
      summary,
      ...(exists ? { backup: target } : {}),
    }
  }

  return { verdict: 'allow', risk: RISK.READ, reason: 'not a policed tool', summary: tool }
}

/** For tools outside this module that touch files and must honour the same lines. */
export const isSecretPath = (p) => SECRET_PATH.test(p)
export const isSystemPath = (p) => SYSTEM_PATH.test(p)
export const isWithinRoots = (p, ctx) => ctx.roots.some((root) => within(p, root, ctx))

/**
 * Token-shaped text, and values introduced as a secret. Replaced, not just
 * flagged, in anything written to the audit log: a command line can carry a
 * bearer token as easily as a path.
 */
const TOKENISH = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
]
const LABELLED_SECRET = /\b(bearer|password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)(["']?\s*[:= ]\s*["']?)[^\s"'&]{4,}/gi

export function redactSecrets(text) {
  let s = String(text)
  for (const re of TOKENISH) s = s.replace(re, '[redacted]')
  return s.replace(LABELLED_SECRET, (_m, label, sep) => `${label}${sep}[redacted]`)
}

/**
 * Tool arguments as the audit log keeps them: the shape and the short values
 * (an entity id, an address, a count) but never a body of text. A message,
 * an email, a file's contents arrive as "<1234 chars>".
 */
export function auditArgs(input, max = 600) {
  const shrink = (v) => {
    if (typeof v === 'string') return v.length > 80 ? `<${v.length} chars>` : redactSecrets(v)
    if (Array.isArray(v)) return v.length > 10 ? `<${v.length} items>` : v.map(shrink)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /content|body|text|html|data|raw|message|note|description/i.test(k) && typeof x === 'string' ? `<${x.length} chars>` : shrink(x)]))
    return v
  }
  return JSON.stringify(shrink(input ?? {})).slice(0, max)
}

/**
 * Verbs, read out of an MCP tool's name. READ_VERB is anchored, so it reads
 * the verb rather than the noun; `screenshot` is here because it is a read
 * that doesn't sound like one. EFFECTFUL_VERB is not anchored —
 * `make_outbound_call` and `Bulk-Edit-Events` hide their verb mid-name — and
 * names every way a tool can act for the person: `forward` sends mail as
 * surely as `send` does, `trash` deletes, `respond` answers an invitation.
 */
export const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i
export const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)|(?:^|[^a-z])(forward|reply|respond|trash|spam|archive|share|invite|book|order|submit|upload|transfer|unsubscribe|move|label|mark|cancel|click|key|input|accept|decline)(?![a-z])/i

/** The browser tools that only look, scroll or open tabs. The rest act on pages. */
const CHROME_LOOKS = new Set([
  'chrome_status', 'chrome_tabs', 'chrome_navigate', 'chrome_read_page', 'chrome_page_text', 'chrome_find',
  'chrome_screenshot', 'chrome_scroll', 'chrome_console', 'chrome_network', 'chrome_new_tab', 'chrome_close_tab',
])

/**
 * An MCP tool from outside JARVIS — a claude.ai connector, a server in
 * ~/.claude.json, the browser — once writes are on.
 *
 * Its arguments mean nothing to this module, so the name decides, and the
 * default is to ask: only a tool whose name begins with a read verb and
 * contains no action verb runs unasked. A list of risky verbs alone was the
 * wrong way round — `forward_message` and `trash_thread` named no verb on it
 * and ran without a prompt.
 *
 * @returns {null | { verdict: 'confirm', risk: string, reason: string }}
 */
export function assessExternalMcp(server, tool, exempt = new Set()) {
  if (exempt.has(`${server}__${tool}`)) return null
  if (server === 'jarvis_chrome' && CHROME_LOOKS.has(tool)) return null
  if (READ_VERB.test(tool) && !EFFECTFUL_VERB.test(tool)) return null
  return {
    verdict: 'confirm',
    risk: EFFECTFUL_VERB.test(tool) ? RISK.COMMUNICATION : RISK.REVERSIBLE,
    reason: `uses ${server.replace(/^claude_ai_/, '')} to ${tool.replace(/[_-]+/g, ' ').toLowerCase()}`,
  }
}
