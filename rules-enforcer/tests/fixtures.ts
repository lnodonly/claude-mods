import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const ROOT = '/p'

export const RULES_JSON = JSON.stringify({
  skills: [
    { paths: ['config/schema.json', 'config/templates/**'], skill: 'schema-rules' },
    { commands: ['^\\s*migrate\\s'], skill: 'db-migrations' },
  ],
  docs: [{ paths: ['config/templates/*.html'], docs: ['docs/style-guide.md'] }],
})

// Everything below sits beneath the plugin and stands in for the engine.
export function setup(
  on: On,
  files: Record<string, string>,
  opts: {
    cwd?: string
    mtime?: (path: string) => number
    failEdits?: boolean
    statThrows?: boolean
    onBash?: (command: string) => void
    /** A git repo at ROOT: the files listed here match HEAD; any other file there shows as modified. */
    git?: { clean: string[] }
    /** $HOME; '/h' unless given. */
    home?: string
  } = {},
) {
  const ui = {
    status: undefined as string | undefined,
    notices: [] as string[],
    toasts: [] as string[],
    store: new Map<string, unknown>(),
  }
  on('store.get', ($, e) => ({ value: ui.store.get(e.key) }))
  on('store.set', ($, e) => {
    ui.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: opts.cwd ?? ROOT }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  const mtime = (p: string) => opts.mtime?.(p) ?? 1
  const isDir = (p: string) => Object.keys(files).some(f => f.startsWith(p === '/' ? '/' : `${p}/`))
  on('fs.stat', ($, e) => {
    if (opts.statThrows) throw new Error(`ENOENT: ${e.path}`)
    if (e.path in files) {
      return { value: { kind: 'file' as const, size: files[e.path]!.length, mtimeMs: mtime(e.path), isLink: false } }
    }
    if (isDir(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', ($, e) => {
    const prefix = e.path === '/' ? '/' : `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue
      const [head, ...rest] = f.slice(prefix.length).split('/')
      names.set(head!, rest.length > 0 ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: kind === 'file' ? mtime(`${prefix}${name}`) : 0,
      })) as never,
    }
  })
  // Without the git option the folder isn't a repo, as git answers outside one.
  on('process.run', ($, e) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    const a = [...e.argv]
    if (a[0] !== 'git' || opts.git === undefined) return out('', 128)
    const dir = a[2]!
    const name = a[a.length - 1]!
    const abs = `${dir}/${name}`
    return out(opts.git.clean.includes(abs) ? '' : ` M ${name}\n`)
  })
  mock.clock(on, { now: 0 })
  mock.env(on, { HOME: opts.home ?? '/h' })
  on('ui.status', ($, e) => {
    ui.status = e.text
    return { value: undefined }
  })
  on('ui.notice', ($, e) => {
    ui.notices.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    ui.toasts.push(e.text)
    return { value: undefined }
  })
  // The engine's own answer to classic events: no decision.
  on('classic.PostCompact', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('classic.SessionEnd', () => ({}))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  const answer = (fails: boolean) => ($: unknown, e: object) => {
    const { command } = e as { command?: string }
    if (command !== undefined) opts.onBash?.(command)
    return fails && opts.failEdits
      ? ({ result: 'failed', text: 'failed', isError: true } as never)
      : ({ result: 'ok', text: 'ok' } as never)
  }
  on('tool.call', { tool: 'Edit' }, answer(true))
  on('tool.call', { tool: 'Write' }, answer(true))
  on('tool.call', { tool: 'Bash' }, answer(true))
  on('tool.call', { tool: 'Skill' }, answer(false))
  return ui
}

export const edit = (file_path: string) =>
  ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const
