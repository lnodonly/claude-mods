import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { age, autoNote, FORK_PROMPT, fullNote, legacyKey, noteKey, parseNote, previousSection, relativeTo, type Note } from './note'

export const note = atom({ plugin: 'handoff', key: 'note' } as const, null as Note | null)
// This session did work worth handing off (drives the Write handoff note button).
export const worked = atom({ plugin: 'handoff', key: 'worked' } as const, false)
// A note is being written from the button.
export const writing = atom({ plugin: 'handoff', key: 'writing' } as const, false)
// The folder the session started in, which names its note. Held by the host for the session, so it
// outlives a hot reload, whose session.start gives the shell's folder (live, 2026-10-10); /cd and
// a worktree move change the project root. A new session starts with it empty.
export const startFolder = atom({ plugin: 'handoff', key: 'folder' } as const, '')

async function markWork($: EngineInterface) {
  dirty = true
  if (!(await read($, worked))) await update($, worked, () => true)
}

// This session, in module memory (a hot reload starts it fresh).
let cwd = ''
let dirty = false
// Something was edited, or Bash changed files (or ran outside any repo), not just talked about.
let changed = false
// -p and SDK runs neither write notes nor get one as context.
let interactive = true
const files = new Set<string>()
const tasks = new Map<string, { subject: string; status: string }>()
let todos: { content: string; status: string }[] = []
// The last typed request, read from the transcript after each turn: at exit the engine has often
// unbound the session already, so the transcript can't be read then.
let lastSeen: string | undefined
// Each repo's git state from before the first Bash command run in it, by top folder, to find
// what Bash changed.
const bases = new Map<string, GitState>()
// Folders git has been asked about: before a Bash command only the others need asking.
const seen = new Set<string>()
// Repos in the project folder's direct subfolders, found at the session's first Bash command.
let subrepos: string[] | undefined

function reset(folder: string) {
  cwd = folder
  dirty = false
  changed = false
  lastSeen = undefined
  bases.clear()
  seen.clear()
  subrepos = undefined
  files.clear()
  tasks.clear()
  todos = []
}

// After a hot reload the module has no folder: take the one kept for the session, else the project
// root, which a shell `cd` doesn't move (the shell's folder named a note after a subfolder, 2026-10-08).
async function folder($: EngineInterface): Promise<string> {
  if (cwd === '') cwd = (await read($, startFolder).catch(() => '')) || (await $.session.root())
  return cwd
}

// Puts the folder in the session's state when it holds none. /clear empties that state (live,
// 2026-10-10), so it is kept again once the new conversation starts, and at each prompt and before
// each Bash command (the shell may cd) in case that came too early.
async function keep($: EngineInterface) {
  try {
    if ((await read($, startFolder)) !== '') return
    const dir = await folder($)
    await update($, startFolder, () => dir)
  } catch {
    // Not kept: a reload goes by its session.start's folder, as before.
  }
}

async function notePath($: EngineInterface): Promise<{ path: string; shown: string; legacy: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = await folder($)
  const name = `${await noteKey(dir)}.md`
  return { path: `${home}/.claude/handoffs/${name}`, shown: `~/.claude/handoffs/${name}`, legacy: `${home}/.claude/handoffs/${legacyKey(dir)}.md` }
}

// A note under the old key (no hash) is the folder's until one is written or cleared under the new
// key; it isn't moved, as another folder that read alike may share it.
async function readNote($: EngineInterface): Promise<string> {
  const { path, legacy } = await notePath($)
  if (await $.fs.exists(path)) return (await $.fs.read(path)) as string
  // An old key too long for a file name was never written.
  return (await $.fs.exists(legacy).catch(() => false)) ? ((await $.fs.read(legacy)) as string) : ''
}

type ToolResult = { deny?: string; isError?: boolean; result?: unknown }
const ok = (r: ToolResult) => r.deny === undefined && r.isError !== true

// Trackers: hooks must be top-level functions.
async function trackEdit($: EngineInterface, e: { file_path?: unknown; notebook_path?: unknown }, next: (e: never) => Promise<ToolResult>) {
  const r = await next(e as never)
  const path = e.file_path ?? e.notebook_path
  if (ok(r) && typeof path === 'string') {
    files.add(relativeTo(await folder($), path))
    changed = true
    await markWork($)
  }
  return r
}

type GitState = { top: string; head: string; dirty: Set<string> }

// Read-only git: no index refresh, no fsmonitor. Any failure means "no answer".
async function git($: EngineInterface, root: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', root, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args])
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

// Porcelain -z: "XY path", and a rename or copy is followed by its old path, which is skipped.
function porcelainPaths(out: string): string[] {
  const parts = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.length < 4) continue
    paths.push(p.slice(3))
    if (/[RC]/.test(p.slice(0, 2))) i++
  }
  return paths
}

async function gitState($: EngineInterface, root: string): Promise<GitState | null> {
  const top = await git($, root, ['rev-parse', '--show-toplevel'])
  if (top === null) return null
  const status = await git($, root, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (status === null) return null
  // A repo with no commits yet has no HEAD.
  const head = (await git($, root, ['rev-parse', 'HEAD']))?.trim() ?? ''
  return { top: top.trim(), head, dirty: new Set(porcelainPaths(status)) }
}

// More repos than this one level down make a folder of projects (all one's clones, say), not one
// project: none of them is watched, as asking git about each after every command would be slow.
const MAX_SUBREPOS = 10

// The project folder's direct subfolders that are repos (a `.git` folder, or file for a worktree
// or submodule). Links aren't followed, and nothing deeper is looked at (node_modules and the like).
async function findSubrepos($: EngineInterface, root: string): Promise<string[]> {
  const entries = await $.fs.list(root).catch(() => [])
  const dirs = entries.filter(x => x.kind === 'dir').map(x => `${root}/${x.name}`)
  const has = await Promise.all(dirs.map(d => $.fs.exists(`${d}/.git`).catch(() => false)))
  const found = dirs.filter((_, i) => has[i])
  return found.length > MAX_SUBREPOS ? [] : found
}

// The folders whose repos Bash may have touched: the project folder, repos in its direct
// subfolders, and the shell's folder. A workspace folder may not be a repo itself while the folders
// in it are (live, 2026-10-09), and the shell may stay at its root (backlog #136).
async function watched($: EngineInterface): Promise<string[]> {
  const root = await folder($)
  if (subrepos === undefined) subrepos = await findSubrepos($, root)
  const shell = await $.session.cwd().catch(() => '')
  return [...new Set([root, ...subrepos, shell])].filter(d => d !== '')
}

// Each repo once, asking git about the folders in parallel.
async function repos($: EngineInterface, dirs: string[]): Promise<GitState[]> {
  const out: GitState[] = []
  for (const st of await Promise.all(dirs.map(d => gitState($, d)))) if (st !== null && !out.some(o => o.top === st.top)) out.push(st)
  for (const d of dirs) seen.add(d)
  return out
}

// What git shows changed in a repo since its base: files newly dirty, and files in commits since.
async function changedSince($: EngineInterface, base: GitState, now: GitState): Promise<string[]> {
  const found = [...now.dirty].filter(f => !base.dirty.has(f))
  if (base.head !== '' && now.head !== base.head) {
    const diff = await git($, base.top, ['diff', '--name-only', '-z', base.head, now.head])
    found.push(...(diff ?? '').split('\0').filter(f => f !== ''))
  }
  return found
}

// Bash edits files the Edit tracker never sees: list what git shows changed since the first
// Bash command in each repo, newly dirty or committed. Files already dirty then aren't counted, and
// a repo first entered by a command (cd and edit in one) starts counting after it.
// A read-only command (git log to answer "where were we?") changes nothing, so it doesn't count as
// a change; with no repo in view there's no telling, so it does. A refused command never ran, and
// one that failed counts only for the files git shows it changed.
async function trackBash($: EngineInterface, e: unknown, next: (e: never) => Promise<ToolResult>) {
  await keep($)
  // Before the command, only folders git hasn't been asked about yet: the others have their base.
  for (const st of await repos($, (await watched($)).filter(d => !seen.has(d)))) if (!bases.has(st.top)) bases.set(st.top, st)
  const r = await next(e as never)
  if (r.deny !== undefined) return r
  const root = await folder($)
  const after = await repos($, await watched($))
  let touched = ok(r) && after.length === 0
  for (const now of after) {
    const base = bases.get(now.top)
    if (base === undefined) {
      bases.set(now.top, now)
      continue
    }
    const found = await changedSince($, base, now)
    for (const f of found) files.add(relativeTo(root, `${now.top}/${f}`))
    if (found.length > 0) touched = true
  }
  if (touched) changed = true
  if (touched || ok(r)) await markWork($)
  return r
}

// A user's own `!` command reaches a mod only as rows the session keeps by the command door, the
// user's `<bash-input>` and then its `<bash-stdout>`: no prompt, no tool call (live, 2026-10-10).
// A typed prompt and Claude's answers come by other doors; a slash command's rows by this one hold
// other text.
type Row = { door: string; origin: { kind: string }; agentId?: string; message: { type: string; content: { type: string; text?: string }[] } }
function shellRow(e: Row): 'input' | 'output' | undefined {
  if (e.door !== 'command' || e.message.type !== 'user' || e.agentId !== undefined) return undefined
  if (!['unclassified', 'composer', 'bridge'].includes(e.origin.kind)) return undefined
  const text = e.message.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('').trimStart()
  if (text.startsWith('<bash-input>')) return 'input'
  return text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>') ? 'output' : undefined
}

// There's no telling what a `!` command did, as with a Bash command with no repo in view, so it
// counts as a change. Repos that already have a base list what git shows changed once it has run;
// none gets a new base here.
async function trackShell($: EngineInterface, e: Row, next: (e: never) => Promise<unknown>) {
  const r = await next(e as never)
  try {
    const row = shellRow(e)
    if (row === 'input') {
      changed = true
      await markWork($)
    } else if (row === 'output' && bases.size > 0) {
      const root = await folder($)
      const known = [...bases.values()]
      const now = await Promise.all(known.map(b => gitState($, b.top)))
      for (const [i, st] of now.entries()) {
        if (st !== null) for (const f of await changedSince($, known[i]!, st)) files.add(relativeTo(root, `${st.top}/${f}`))
      }
    }
  } catch {
    // Never in the way of the row.
  }
  return r
}

async function trackTaskCreate($: EngineInterface, e: unknown, next: (e: never) => Promise<ToolResult>) {
  const r = await next(e as never)
  const task = (r.result as { task?: { id?: string; subject?: string } } | undefined)?.task
  if (ok(r) && task?.id !== undefined) tasks.set(task.id, { subject: task.subject ?? '', status: 'pending' })
  return r
}

async function trackTaskUpdate($: EngineInterface, e: { taskId?: string; subject?: string; status?: string }, next: (e: never) => Promise<ToolResult>) {
  const r = await next(e as never)
  const t = e.taskId === undefined ? undefined : tasks.get(e.taskId)
  if (ok(r) && t !== undefined) tasks.set(e.taskId!, { subject: e.subject ?? t.subject, status: e.status ?? t.status })
  return r
}

async function trackTodo($: EngineInterface, e: { todos?: { content: string; status: string }[] }, next: (e: never) => Promise<ToolResult>) {
  const r = await next(e as never)
  if (ok(r) && Array.isArray(e.todos)) todos = e.todos.map(t => ({ content: t.content, status: t.status }))
  return r
}

// The user's last request as the transcript stores it: a redacting mod that scrubs rows on the
// way in keeps a secret pasted into a prompt out of the note.
// When there's none, why: the note says so instead of a bare None.
async function lastRequest($: EngineInterface): Promise<{ text: string } | { missing: string }> {
  let rows: { role: string; text: string; toolResults?: unknown[] }[]
  try {
    rows = (await $.session.messages()) as typeof rows
  } catch (err) {
    return { missing: `couldn't read the transcript at exit: ${(err as Error).message}` }
  }
  if (!Array.isArray(rows)) return { missing: `the transcript read at exit wasn't a list (${JSON.stringify(rows).slice(0, 80)})` }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.role === 'user' && (r.toolResults?.length ?? 0) === 0 && typeof r.text === 'string' && r.text.trim() !== '' && !/^\s*[</]/.test(r.text)) return { text: r.text.trim() }
  }
  const users = rows.filter(r => r.role === 'user')
  const first = users.at(-1)
  return { missing: `the transcript had ${rows.length} messages at exit, ${users.length} from the user, none a typed request${first ? ` (last user row: ${JSON.stringify({ text: String(first.text ?? '').slice(0, 40), toolResults: first.toolResults?.length ?? 0 })})` : ''}` }
}

async function load($: EngineInterface) {
  const loaded = interactive ? parseNote(await readNote($).catch(() => '')) : undefined
  await update($, note, () => loaded ?? null)
  // prompt.context is cached: the engine may have built it (with no note) before this ran, as at
  // session start, where Claude then said it had no earlier context (live test, 2026-10-08).
  $.ui.invalidate('prompt.context')
  return loaded
}

const openTasks = () => [
  ...[...tasks.values()].filter(t => t.status !== 'completed' && t.status !== 'deleted').map(t => t.subject),
  ...todos.filter(t => t.status !== 'completed').map(t => t.content),
]

// A full, model-written note (/handoff or the band's button).
export async function writeFull($: EngineInterface): Promise<string> {
  const { path, shown } = await notePath($)
  const reply = await $.model.fork({ prompt: FORK_PROMPT })
  if (!reply.isAnswered) return `Couldn't write the handoff note: ${(reply as { reason?: string }).reason ?? 'no reply'}.`
  const text = fullNote(cwd, await $.clock.now(), (reply as { text: string }).text)
  await $.fs.write(path, text)
  dirty = false
  await update($, worked, () => false)
  const steps = parseNote(text)?.steps ?? []
  return `Handoff saved to ${shown}.${steps.length > 0 ? `\n\nNext steps:\n${steps.map(s => `- ${s}`).join('\n')}` : ''}`
}

// A hook on a mod's noun gets and answers { value } (modbar's calls).
const valueOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { value?: unknown[] } | null)?.value ?? []))
const answer = (v: unknown) => ({ value: v }) as never

// Automatic notes are off unless /handoff auto on; persisted in $.store, so the setting sticks.
// A store that fails counts as off.
const AUTO = 'auto'
const autoOn = async ($: EngineInterface) => (await $.store.get(AUTO).catch(() => undefined)) === true
const autoText = (on: boolean) =>
  on
    ? 'Automatic notes are on: exit saves a quick note when work happened. /handoff auto off turns them off.'
    : 'Automatic notes are off: exit saves no note. /handoff auto on turns them on.'
const USAGE = 'Usage: /handoff [show|clear|auto [on|off]]'

// What modbar draws: once there's work, the write button. The previous note isn't drawn: Claude
// gets it as context, and a checklist above the prompt was noise (the user, 2026-10-08).
export function blocksFor(s: { worked: boolean; writing: boolean; interactive: boolean }) {
  if (!s.worked || !s.interactive) return []
  return [{ id: 'handoff.write', owner: 'handoff', order: 13, width: 'fit', align: 'right', lines: [{ pieces: [{ button: { key: 'handoff-write', label: s.writing ? 'Writing handoff note…' : 'Write handoff note' } }] }] }]
}

export const register: Register = on => {
  // modbar's noun as modbar adds it, beneath what's already there: without modbar this mod still
  // loads and keeps its notes (nothing asks for its button); with it, whichever is built first gives
  // the same core, so no step replaces another's. The core stays modbar's: no blocks, no press taken.
  on('engine.create', async ($, e, next) => ({ modbar: { blocks: async () => [], press: async () => false }, ...(await next(e)) }) as never)

  // Also fired by a hot reload, with the shell's folder. A folder already kept means this session
  // goes on: its note's folder, the Write button and the note Claude was given stay as they are.
  on('session.start', async ($, e, next) => {
    const held = await read($, startFolder).catch(() => '')
    const isNew = held === ''
    reset(isNew ? e.cwd : held)
    await keep($)
    if (isNew) await update($, worked, () => false)
    interactive = e.isInteractive !== false
    await $.command.register({ name: 'handoff', description: 'Write a handoff note for the next session here: /handoff [show|clear|auto [on|off]]' })
    const ran = await next(e)
    // The note is for Claude (context); its steps are Claude's, not something for the user to send,
    // so none is suggested in the prompt box (the user, 2026-10-08). After a reload the note on disk
    // may be this session's own (/handoff), not the previous one's.
    if (isNew) await load($)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    await keep($)
    const kind = (e as { origin?: { kind?: string } }).origin?.kind
    const text = (e as { text?: string }).text ?? ''
    if ((kind === 'composer' || kind === 'bridge') && !text.trimStart().startsWith('/')) await markWork($)
    return next(e)
  })

  // After each main-loop turn, while the session can still be read.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (interactive && (e as { agentId?: string }).agentId === undefined) {
      const req = await lastRequest($).catch(() => undefined)
      if (req !== undefined && 'text' in req) lastSeen = req.text
    }
    return r
  })

  on('tool.call', { tool: 'Edit' }, trackEdit as never)
  on('tool.call', { tool: 'Write' }, trackEdit as never)
  on('tool.call', { tool: 'NotebookEdit' }, trackEdit as never)
  on('tool.call', { tool: 'Bash' }, trackBash as never)
  on('session.append', { door: 'command' }, trackShell as never)
  on('tool.call', { tool: 'TaskCreate' }, trackTaskCreate as never)
  on('tool.call', { tool: 'TaskUpdate' }, trackTaskUpdate as never)
  on('tool.call', { tool: 'TodoWrite' }, trackTodo as never)

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = e.args.trim()
    const { path, shown } = await notePath($)
    if (arg === 'show') {
      const text = await readNote($)
      return { text: text.trim() === '' ? 'No handoff note for this folder.' : text }
    }
    if (arg === 'clear') {
      await $.fs.write(path, '')
      return { text: 'Cleared the handoff note for this folder.' }
    }
    const [verb, value, ...rest] = arg.split(/\s+/)
    if (verb === 'auto' && rest.length === 0) {
      if (value === undefined) return { text: autoText(await autoOn($)) }
      if (value === 'on' || value === 'off') {
        await $.store.set(AUTO, value === 'on')
        return { text: autoText(value === 'on') }
      }
    }
    if (arg !== '') return { text: USAGE }
    return { text: await writeFull($) }
  })

  // Exit: a quick note without a model call, only when automatic notes are on and work happened;
  // never blocks exit.
  on('session.end', async ($, e, next) => {
    if (dirty && interactive && (await autoOn($))) {
      try {
        const { path } = await notePath($)
        const prev = parseNote(await readNote($))
        const live = await lastRequest($)
        const req = 'text' in live || lastSeen === undefined ? live : { text: lastSeen }
        const text = autoNote(cwd, await $.clock.now(), { ...('text' in req ? { lastRequest: req.text } : { lastRequestMissing: req.missing }), files: [...files], tasks: openTasks(), previous: previousSection(prev) })
        // A talk-only session (e.g. one "where were we?") leaves an existing note alone.
        const talkOnly = !changed && tasks.size === 0 && todos.length === 0
        if (prev === undefined || !talkOnly) await $.fs.write(path, text)
      } catch {
        // A failed write loses this note; exit goes on.
      }
    }
    // A /clear goes on in this process without a session.start: start the tracking over and
    // give the next conversation the note as it now stands. That conversation's state starts empty
    // once this hook is done: the timer keeps the folder in it.
    reset(cwd)
    await load($).catch(() => undefined)
    try {
      $.clock.after(0, () => void keep($))
    } catch {
      // Kept at the next prompt or Bash command instead.
    }
    return next(e)
  })

  on('modbar.blocks', async ($, e, next) => {
    const below = valueOf(await next(e))
    const mine = blocksFor({ worked: await read($, worked), writing: await read($, writing), interactive })
    return answer([...below, ...mine])
  })

  on('modbar.press', async ($, e, next) => {
    if (e.owner !== 'handoff') return next(e)
    if (e.key === 'handoff-write') {
      if (!(await read($, writing))) {
        await update($, writing, () => true)
        try {
          $.ui.toast((await writeFull($)).split('\n')[0]!)
        } finally {
          await update($, writing, () => false)
        }
      }
    } else return next(e)
    return answer(true)
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const n = await read($, note)
    if (n === null || !interactive) return r
    const old = age(n.written, await $.clock.now())
    const text = `Handoff note from the previous session in this folder (${n.kind}, ${n.written || 'undated'}${old ? `, ${old}` : ''}):\n\n${n.text.slice(0, 6000)}`
    return { ...r, blocks: [...r.blocks, { name: 'handoff', text }] }
  })
}
