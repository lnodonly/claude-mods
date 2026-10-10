import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { autoNote, FORK_PROMPT, fullNote, noteKey, parseNote, previousSection, relativeTo, type Note } from './note'

export const note = atom({ plugin: 'handoff', key: 'note' } as const, null as Note | null)
// This session did work worth handing off (drives the Write handoff note button).
export const worked = atom({ plugin: 'handoff', key: 'worked' } as const, false)
// A note is being written from the button.
export const writing = atom({ plugin: 'handoff', key: 'writing' } as const, false)

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

function reset(folder: string) {
  cwd = folder
  dirty = false
  changed = false
  lastSeen = undefined
  bases.clear()
  files.clear()
  tasks.clear()
  todos = []
}

// After a hot reload the module has no folder: take the project root, which a shell `cd` doesn't
// move (the shell's folder named a note after a subfolder, 2026-10-08).
async function folder($: EngineInterface): Promise<string> {
  if (cwd === '') cwd = await $.session.root()
  return cwd
}

async function notePath($: EngineInterface): Promise<{ path: string; shown: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const name = `${noteKey(await folder($))}.md`
  return { path: `${home}/.claude/handoffs/${name}`, shown: `~/.claude/handoffs/${name}` }
}

async function readNote($: EngineInterface): Promise<string> {
  const { path } = await notePath($)
  return (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
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

// The repos Bash may have touched: the project folder's and the shell's folder's, once each. A
// workspace folder may not be a repo itself while the one Claude cd's into is (live, 2026-10-09).
async function repos($: EngineInterface): Promise<GitState[]> {
  const shell = await $.session.cwd().catch(() => '')
  const out: GitState[] = []
  for (const dir of new Set([await folder($), shell])) {
    if (dir === '') continue
    const st = await gitState($, dir)
    if (st !== null && !out.some(o => o.top === st.top)) out.push(st)
  }
  return out
}

// Bash edits files the Edit tracker never sees: list what git shows changed since the first
// Bash command in each repo, newly dirty or committed. Files already dirty then aren't counted, and
// a repo first entered by a command (cd and edit in one) starts counting after it.
// A read-only command (git log to answer "where were we?") changes nothing, so it doesn't count as
// a change; outside any repo there's no telling, so it does.
async function trackBash($: EngineInterface, e: unknown, next: (e: never) => Promise<ToolResult>) {
  for (const st of await repos($)) if (!bases.has(st.top)) bases.set(st.top, st)
  const r = await next(e as never)
  await markWork($)
  const root = await folder($)
  const after = await repos($)
  if (after.length === 0) changed = true
  for (const now of after) {
    const base = bases.get(now.top)
    if (base === undefined) {
      bases.set(now.top, now)
      continue
    }
    const found = [...now.dirty].filter(f => !base.dirty.has(f))
    if (base.head !== '' && now.head !== base.head) {
      const diff = await git($, base.top, ['diff', '--name-only', '-z', base.head, now.head])
      found.push(...(diff ?? '').split('\0').filter(f => f !== ''))
    }
    for (const f of found) files.add(relativeTo(root, `${now.top}/${f}`))
    if (found.length > 0) changed = true
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
  on('session.start', async ($, e, next) => {
    reset(e.cwd)
    await update($, worked, () => false)
    interactive = e.isInteractive !== false
    await $.command.register({ name: 'handoff', description: 'Write a handoff note for the next session here: /handoff [show|clear|auto [on|off]]' })
    const ran = await next(e)
    // The note is for Claude (context); its steps are Claude's, not something for the user to send,
    // so none is suggested in the prompt box (the user, 2026-10-08).
    await load($)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
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
    // give the next conversation the note as it now stands.
    reset(cwd)
    await load($).catch(() => undefined)
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
    const text = `Handoff note from the previous session in this folder (${n.kind}, ${n.written || 'undated'}):\n\n${n.text.slice(0, 6000)}`
    return { ...r, blocks: [...r.blocks, { name: 'handoff', text }] }
  })
}
