import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/Users/u'
const CWD = '/Users/u/Repository/my-project'
const NOTE = `${HOME}/.claude/handoffs/-Users-u-Repository-my-project-0af20ff9.md`
const AT = new Date(2026, 9, 7, 21, 40).getTime()
const BODY = '## Done\n\nFixed login.\n\n## Where things stand\n\nOK.\n\n## Next steps\n\n- [ ] Check the staging site\n- [ ] Run the linter\n\n## Open questions\n\nNone.\n\n## Gotchas\n\nNone.'

type Opts = { files?: Record<string, string>; store?: Record<string, unknown>; storeThrows?: boolean; fork?: { isAnswered: boolean; text?: string; reason?: string }; writeFails?: boolean; scrub?: (t: string) => string; shellCwd?: string; git?: Git; bash?: 'deny' | 'error'; list?: Entry[] }
type Entry = { name: string; kind: 'file' | 'dir' | 'other' }
type GitState = { head: string; status: string[]; diff?: string[] }
type Git = { top: string; before: GitState; after: GitState }

function setup(on: On, opts: Opts = {}) {
  on('engine.create', async ($, e, next) => ({ ...(await next(e)), modbar: { blocks: async () => [], press: async () => false } }) as never)
  const files: Record<string, string> = { ...(opts.files ?? {}) }
  const ui = { writes: [] as string[], suggested: [] as string[], gitDirs: [] as string[] }
  mock.env(on, { HOME })
  mock.clock(on, { now: AT })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  // The project folder's entries; any other folder is empty.
  on('fs.list', ($, e) => ({ value: (e.path === CWD ? (opts.list ?? []) : []).map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: x.kind === 'other' })) }) as never)
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }) as never)
  on('fs.write', ($, e) => {
    if (opts.writeFails) throw new Error('disk full')
    files[e.path] = e.text
    ui.writes.push(e.path)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  // Automatic notes are off by default; most tests here are about them, so they turn them on.
  const store: Record<string, unknown> = { ...(opts.store ?? { auto: true }) }
  on('store.get', ($, e) => {
    if (opts.storeThrows) throw new Error('store unavailable')
    return { value: store[e.key] } as never
  })
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('session.cwd', () => ({ value: opts.shellCwd ?? CWD }) as never)
  on('session.root', () => ({ value: CWD }) as never)
  on('model.fork', () => ({ value: opts.fork ?? { isAnswered: true, text: BODY } }) as never)
  on('prompt.suggest', ($, e) => {
    ui.suggested.push(e.text)
    return { isShown: true } as never
  })
  // The transcript as stored: a redacting mod may scrub rows on the way in (scrub stands in for it).
  const rows: { role: 'user' | 'assistant'; text: string; toolUses: unknown[] }[] = []
  on('prompt.submit', ($, e) => {
    rows.push({ role: 'user', text: (opts.scrub ?? (t => t))(e.text), toolUses: [] })
    return { text: e.text } as never
  })
  // At exit the engine may have unbound the session already (as live): then the transcript can't be read.
  let bound = true
  // Unbound, the call goes on to the engine beneath, which (with no transcript) throws, as live.
  on('session.messages', ($, e, next) => (bound ? ({ value: rows } as never) : next(e)))
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }) as never)
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: 'x', oldString: 'a', newString: 'b' } }) as never)
  let ran = false
  // bash: a guard refuses the command (it never runs), or it runs and fails.
  on('tool.call', { tool: 'Bash' }, () => {
    if (opts.bash === 'deny') return { deny: 'Refused by a guard.' } as never
    ran = true
    if (opts.bash === 'error') return { isError: true, result: 'Exit code 1', text: 'Exit code 1' } as never
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  // No git option: not a git folder, as git answers outside a repo.
  on('process.run', ($, e) => {
    const a = [...e.argv].filter(x => !['--no-optional-locks', '-c', 'core.fsmonitor=false'].includes(x))
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    const dir = a[2] ?? ''
    if (a[0] === 'git') ui.gitDirs.push(dir)
    const g = opts.git !== undefined && (dir === opts.git.top || dir.startsWith(`${opts.git.top}/`)) ? opts.git : undefined
    if (a[0] !== 'git' || g === undefined) return out('', 128)
    const st = ran ? g.after : g.before
    const cmd = a.slice(3).join(' ')
    if (cmd === 'rev-parse --show-toplevel') return out(`${g.top}\n`)
    if (cmd === 'rev-parse HEAD') return out(`${st.head}\n`)
    if (cmd === 'status --porcelain -z --untracked-files=all') return out(st.status.map(x => `${x}\0`).join(''))
    if (cmd === `diff --name-only -z ${g.before.head} ${st.head}`) return out((st.diff ?? []).map(x => `${x}\0`).join(''))
    return out('', 1)
  })
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: `t-${e.subject}`, subject: e.subject } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true } }) as never)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }) as never)
  return { files, ui, store, unbind: () => { bound = false } }
}

const run = (args: string) => ({ command: 'handoff', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const start = ($: { session: { start: (a: never) => Promise<unknown> } }, isInteractive = true) => $.session.start({ cwd: CWD, surface: null, isInteractive } as never)
const end = ($: { session: { end: (a: never) => Promise<unknown> } }) => $.session.end({ reason: 'exit', sessionId: 's1' } as never)
const submit = ($: { prompt: { submit: (a: never) => Promise<unknown> } }, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

describe('/handoff', () => {
  test('writes a full note and answers with the next steps', async ($, on) => {
    const { files } = setup(on)
    await start($)
    const out = (await $.command.run(run(''))).text!
    expect(files[NOTE]).toBe(`# Handoff · my-project · 2026-10-07 21:40 · full\n\n${BODY}\n`)
    expect(out).toBe('Handoff saved to ~/.claude/handoffs/-Users-u-Repository-my-project-0af20ff9.md.\n\nNext steps:\n- Check the staging site\n- Run the linter')
  })
  test('a failed fork writes nothing', async ($, on) => {
    const { ui } = setup(on, { fork: { isAnswered: false, reason: 'api-error' } })
    await start($)
    expect((await $.command.run(run(''))).text).toBe("Couldn't write the handoff note: api-error.")
    expect(ui.writes).toEqual([])
  })
  test('show and clear', async ($, on) => {
    const { files } = setup(on, { files: { [NOTE]: '# Handoff · x · 2026-10-06 09:00 · full\n\nhello\n' } })
    await start($)
    expect((await $.command.run(run('show'))).text).toBe('# Handoff · x · 2026-10-06 09:00 · full\n\nhello\n')
    expect((await $.command.run(run('clear'))).text).toBe('Cleared the handoff note for this folder.')
    expect(files[NOTE]).toBe('')
    expect((await $.command.run(run('show'))).text).toBe('No handoff note for this folder.')
    expect((await $.command.run(run('nope'))).text).toBe('Usage: /handoff [show|clear|auto [on|off]]')
  })
  // A hot reload wipes module memory; the shell may have cd'd into a subfolder since (live, 2026-10-08).
  test('after a reload, the note goes to the project folder, not the shell folder', async ($, on) => {
    const { files } = setup(on, { shellCwd: `${CWD}/scripts` })
    const out = (await $.command.run(run(''))).text!
    expect(out).toMatch(/^Handoff saved to ~\/\.claude\/handoffs\/-Users-u-Repository-my-project-0af20ff9\.md\./)
    expect(files[NOTE]).toMatch(/^# Handoff · my-project · /)
  })
  // Notes saved before keys had a hash (backlog #79) stay the folder's until a new one replaces them.
  test('a note under the old key is still loaded and shown; clearing hides it', async ($, on) => {
    const LEGACY = `${HOME}/.claude/handoffs/-Users-u-Repository-my-project.md`
    const old = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nOld work.\n'
    const { files } = setup(on, { files: { [LEGACY]: old } })
    await start($)
    const ctx = (await $.prompt.context({ blocks: [] } as never)) as { blocks: { name: string; text: string }[] }
    expect(ctx.blocks[0]!.text).toContain('Old work.')
    expect((await $.command.run(run('show'))).text).toBe(old)
    await $.command.run(run('clear'))
    expect((await $.command.run(run('show'))).text).toBe('No handoff note for this folder.')
    expect(files[LEGACY]).toBe(old)
  })
  test('a full note replacing an old-key note goes under the new key', async ($, on) => {
    const LEGACY = `${HOME}/.claude/handoffs/-Users-u-Repository-my-project.md`
    const { files } = setup(on, { files: { [LEGACY]: '# Handoff · my-project · 2026-10-06 09:00 · full\n\nOld.\n' } })
    await start($)
    await $.command.run(run(''))
    expect(files[NOTE]).toBe(`# Handoff · my-project · 2026-10-07 21:40 · full\n\n${BODY}\n`)
    expect((await $.command.run(run('show'))).text).toBe(files[NOTE])
  })
})

describe('review fixes', () => {
  const FULL = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nRewired auth.\n\n## Next steps\n\n- [ ] Check the docs\n\n## Gotchas\n\n- Staging is shared.\n'
  test('an automatic note keeps the full note it replaces, below its own sections', async ($, on) => {
    const { files } = setup(on, { files: { [NOTE]: FULL } })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
    await end($)
    const n = files[NOTE]!
    expect(n).toContain('## Next steps\n\nNone written. Run /handoff for next steps.\n\n## Previous full note (2026-10-06 09:00)\n\n#### Done\n\nRewired auth.\n\n#### Gotchas\n\n- Staging is shared.')
    expect(n).not.toContain('#### Next steps')
  })
  test('a second automatic note still keeps that full note', async ($, on) => {
    const { files } = setup(on, { files: { [NOTE]: FULL } })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await end($)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Previous full note (2026-10-06 09:00)\n\n#### Done\n\nRewired auth.')
    expect(files[NOTE]!.match(/Previous full note/g)!.length).toBe(1)
  })
  test('a fork that writes the heading differently still gives next steps', async ($, on) => {
    const { files } = setup(on, { fork: { isAnswered: true, text: '## Done\n\nX.\n\n### Next Steps:\n\n- [ ] Alpha\n\n## Gotchas\n\nNone.' } })
    await start($)
    expect((await $.command.run(run(''))).text).toContain('Next steps:\n- Alpha')
    expect(files[NOTE]).toContain('## Next steps\n\n- [ ] Alpha')
  })
  test('after /clear the new conversation gets the note just written, and tracking starts over', async ($, on) => {
    const { files, ui } = setup(on)
    await start($)
    await submit($, 'Fix the login bug')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    const ctx = (await $.prompt.context({ blocks: [] } as never)) as { blocks: { name: string; text: string }[] }
    expect(ctx.blocks[0]!.text).toContain('(auto, 2026-10-07 21:40)')
    await end($)
    expect(ui.writes.length).toBe(1)
    expect(files[NOTE]).toContain('> Fix the login bug')
  })
  test('the last request is kept after each turn, so a session unbound at exit still has it', async ($, on) => {
    const { files, unbind } = setup(on)
    await start($)
    await submit($, 'Add a third line to notes.txt')
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/notes.txt`, old_string: 'a', new_string: 'b' } as never)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', category: null, explanation: null } as never)
    unbind()
    await end($)
    expect(files[NOTE]).toContain('> Add a third line to notes.txt')
  })
  test('with nothing kept and an unbound session, the note says why the request is missing', async ($, on) => {
    const { files, unbind } = setup(on)
    await start($)
    await submit($, 'Do something')
    unbind()
    await end($)
    expect(files[NOTE]).toMatch(/None \(couldn't read the transcript at exit: .+\)\./)
  })
  test('loading the note at session start rebuilds the cached context', async ($, on) => {
    setup(on, { files: { [NOTE]: '# Handoff · x · 2026-10-07 21:40 · full\n\n## Next steps\n\n- [ ] Alpha\n' } })
    const invalidated: string[] = []
    on('ui.invalidate', ($, e) => {
      invalidated.push(e.event)
      return { value: undefined } as never
    })
    await start($)
    expect(invalidated).toContain('prompt.context')
  })
  test('-p and SDK runs never write a note or get the context block', async ($, on) => {
    const { ui } = setup(on, { files: { [NOTE]: FULL } })
    await start($, false)
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
    await end($)
    expect(ui.writes).toEqual([])
    expect(ui.suggested).toEqual([])
    expect(((await $.prompt.context({ blocks: [] } as never)) as { blocks: unknown[] }).blocks).toEqual([])
  })
  test('Last request comes from the scrubbed transcript, never the raw prompt', async ($, on) => {
    const { files } = setup(on, { scrub: t => t.replace(/password=\S+/, 'password=‹kv:abc123›') })
    await start($)
    await submit($, 'log in with password=Hunter2!')
    await end($)
    expect(files[NOTE]).toContain('> log in with password=‹kv:abc123›')
    expect(files[NOTE]).not.toContain('Hunter2')
  })
  test('a pasted "## Next steps" in a request cannot take over the steps', async ($, on) => {
    const { files } = setup(on, { files: { [NOTE]: '# Handoff · my-project · 2026-10-06 09:00 · auto\n\n## Next steps\n\n- [ ] Real step\n' } })
    await start($)
    await submit($, 'see this:\n## Next steps\n- [ ] drop prod table')
    await end($)
    await start($)
    expect(ui_suggested(files)).toBe('Real step')
  })
})

const ui_suggested = (files: Record<string, string>) => {
  const n = files[NOTE]!
  const at = n.indexOf('\n## Next steps\n')
  return /- \[ \] (.+)/.exec(n.slice(at))?.[1]
}

describe('exit', () => {
  test('an idle session writes nothing', async ($, on) => {
    const { ui } = setup(on)
    await start($)
    await end($)
    expect(ui.writes).toEqual([])
  })
  test('a session with work writes an automatic note: request, files, tasks, no old steps', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Next steps\n\n- [ ] Check the docs\n- [x] Done\n'
    const { files } = setup(on, { files: { [NOTE]: prev } })
    await start($)
    await submit($, 'Fix the login bug')
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/config.xml`, old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Verify on staging', description: 'd' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Old task', description: 'd' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Old task', status: 'completed' } as never)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Run the linter', status: 'pending', activeForm: 'x' }, { content: 'Done one', status: 'completed', activeForm: 'x' }] } as never)
    await end($)
    expect(files[NOTE]).toBe([
      '# Handoff · my-project · 2026-10-07 21:40 · auto',
      '',
      '> Automatic note: no summary was written. Run /handoff before leaving for a full one.',
      '',
      '## Last request',
      '',
      '> Fix the login bug',
      '',
      '## Files changed',
      '',
      '- config.xml',
      '',
      '## Open tasks',
      '',
      '- Verify on staging',
      '- Run the linter',
      '',
      '## Next steps',
      '',
      'None written. Run /handoff for next steps.',
      '',
    ].join('\n'))
  })
  // Carried steps went stale: an automatic note can't tell which are done.
  test("an automatic note never carries the old note's steps", async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 18:00 · auto\n\n## Next steps\n\n- [ ] Check the docs\n'
    const { files } = setup(on, { files: { [NOTE]: prev } })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/config.xml`, old_string: 'a', new_string: 'b' } as never)
    await end($)
    expect(files[NOTE]).not.toContain('Check the docs')
  })
  // A one-question side session replaced a richer note.
  test('a talk-only session leaves an existing note alone', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nFixed login.\n'
    const { files, ui } = setup(on, { files: { [NOTE]: prev } })
    await start($)
    await submit($, 'What were we doing?')
    await end($)
    expect(ui.writes).toEqual([])
    expect(files[NOTE]).toBe(prev)
  })
  // Answering "where did we leave off?" ran git log, and that replaced the richer note (live, 2026-10-09).
  test('a session that only ran read-only Bash in a repo leaves an existing note alone', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nFixed login.\n'
    const git: Git = { top: CWD, before: { head: 'aaa', status: [' M notes.md'] }, after: { head: 'aaa', status: [' M notes.md'] } }
    const { files, ui } = setup(on, { files: { [NOTE]: prev }, git })
    await start($)
    await submit($, 'Where did we leave off?')
    await $.tool.call({ tool: 'Bash', command: 'git log --oneline -15' } as never)
    await end($)
    expect(ui.writes).toEqual([])
    expect(files[NOTE]).toBe(prev)
  })
  test('Bash outside any repo still counts as a change: there is no telling what it did', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nFixed login.\n'
    const { files } = setup(on, { files: { [NOTE]: prev } })
    await start($)
    await submit($, 'Tidy the exports')
    await $.tool.call({ tool: 'Bash', command: 'rm exports/old.csv' } as never)
    await end($)
    expect(files[NOTE]).toContain('> Tidy the exports')
  })
  // Backlog #81: a refused or failed command counted as work, so it replaced the note.
  test('a refused Bash command is not work: nothing is written', async ($, on) => {
    const { ui } = setup(on, { bash: 'deny' })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'rm exports/old.csv' } as never)
    await end($)
    expect(ui.writes).toEqual([])
  })
  test('a failed Bash command outside any repo is not work: an existing note stays', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nFixed login.\n'
    const { files, ui } = setup(on, { files: { [NOTE]: prev }, bash: 'error' })
    await start($)
    await submit($, 'Where did we leave off?')
    await $.tool.call({ tool: 'Bash', command: 'cat notes.md' } as never)
    await end($)
    expect(ui.writes).toEqual([])
    expect(files[NOTE]).toBe(prev)
  })
  test('a failed Bash command in a repo still lists the files git shows it changed', async ($, on) => {
    const git: Git = { top: CWD, before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: [' M config.xml'] } }
    const { files } = setup(on, { git, bash: 'error' })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sed -i "" s/a/b/ config.xml && false' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Files changed\n\n- config.xml\n\n')
  })
  test('a talk-only session still writes a note when the folder has none', async ($, on) => {
    const { files } = setup(on)
    await start($)
    await submit($, 'Plan the release')
    await end($)
    expect(files[NOTE]).toContain('> Plan the release')
  })
  test('/handoff arriving as a prompt does not count as work; nothing more after /handoff', async ($, on) => {
    const { ui } = setup(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.command.run(run(''))
    await submit($, '/handoff')
    await end($)
    expect(ui.writes.length).toBe(1)
  })
  // Files changed by Bash were missing from the note.
  test('files Bash changed or committed are listed, from git; files dirty before are not', async ($, on) => {
    const git: Git = {
      top: CWD,
      before: { head: 'aaa', status: [' M notes.md'] },
      after: { head: 'bbb', status: [' M notes.md', ' M config.xml', '?? scripts/new.sh', 'R  b.xml', 'a.xml'], diff: ['committed.xml'] },
    }
    const { files } = setup(on, { git })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sed -i "" s/a/b/ config.xml' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Files changed\n\n- config.xml\n- scripts/new.sh\n- b.xml\n- committed.xml\n\n')
  })
  test('in a repo above the project folder, Bash changes are listed relative to the folder', async ($, on) => {
    const git: Git = { top: '/Users/u/Repository', before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: [' M my-project/config.xml'] } }
    const { files } = setup(on, { git })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'touch config.xml' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Files changed\n\n- config.xml\n\n')
  })
  // A workspace folder that isn't a repo; its theme folder is. The note said "None" (live, 2026-10-09).
  test('a repo inside the project folder, where the shell is, has its Bash changes listed', async ($, on) => {
    const theme = `${CWD}/theme`
    const git: Git = { top: theme, before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: [' M style.css'] } }
    const { files } = setup(on, { git, shellCwd: theme })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'cp /tmp/style.css style.css' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Files changed\n\n- theme/style.css\n\n')
  })
  // Backlog #136: a workspace folder that isn't a repo holds repos one level down; with the shell at
  // its root no repo was seen, so Bash edits there weren't listed and a read-only command counted.
  const site = `${CWD}/site`
  const workspace = (after: string[]): Opts => ({
    git: { top: site, before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: after } },
    list: [{ name: 'site', kind: 'dir' }, { name: 'notes.md', kind: 'file' }],
    files: { [`${site}/.git`]: '' },
  })
  test('a repo in a subfolder of the project folder is watched while the shell stays at the root', async ($, on) => {
    const { files } = setup(on, workspace([' M style.css']))
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sed -i "" s/a/b/ site/style.css' } as never)
    await end($)
    expect(files[NOTE]).toContain('## Files changed\n\n- site/style.css\n\n')
  })
  test('read-only Bash at a workspace root whose repos are in subfolders leaves an existing note alone', async ($, on) => {
    const prev = '# Handoff · my-project · 2026-10-06 09:00 · full\n\n## Done\n\nFixed login.\n'
    const { files, ui } = setup(on, { ...workspace([]), files: { [`${site}/.git`]: '', [NOTE]: prev } })
    await start($)
    await submit($, 'Where did we leave off?')
    await $.tool.call({ tool: 'Bash', command: 'git -C site log --oneline -15' } as never)
    await end($)
    expect(ui.writes).toEqual([])
    expect(files[NOTE]).toBe(prev)
  })
  test('only folders with .git are watched, and a link is not followed', async ($, on) => {
    const opts = workspace([])
    const { ui } = setup(on, { ...opts, list: [...opts.list!, { name: 'docs', kind: 'dir' }, { name: 'elsewhere', kind: 'other' }], files: { ...opts.files, [`${CWD}/elsewhere/.git`]: '' } })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect([...new Set(ui.gitDirs)].sort()).toEqual([CWD, site])
  })
  test('a folder holding more than 10 repos is a folder of projects: none of them is watched', async ($, on) => {
    const names = Array.from({ length: 11 }, (_, i) => `r${i}`)
    const git: Git = { top: `${CWD}/r0`, before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: [' M a.txt'] } }
    const { files, ui } = setup(on, { git, list: names.map(name => ({ name, kind: 'dir' })), files: Object.fromEntries(names.map(n => [`${CWD}/${n}/.git`, ''])) })
    await start($)
    await submit($, 'Tidy up')
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await end($)
    expect(ui.gitDirs.every(d => d === CWD)).toBe(true)
    expect(files[NOTE]).toContain('## Files changed\n\nNone.\n\n')
  })
  // Each Bash command asked git about every folder before and after it; before is needed only once.
  test('git is asked about a folder before a Bash command only until it has been seen', async ($, on) => {
    const git: Git = { top: CWD, before: { head: 'aaa', status: [] }, after: { head: 'aaa', status: [] } }
    const { ui } = setup(on, { git })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(ui.gitDirs.length).toBe(6)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(ui.gitDirs.length).toBe(9)
  })
  test('a failed write never blocks exit', async ($, on) => {
    setup(on, { writeFails: true })
    await start($)
    await submit($, 'something')
    expect(await end($)).toEqual({ sessionId: 's1' })
  })
})

describe('automatic notes setting', () => {
  const work = async ($: never) => {
    const $$ = $ as { tool: { call: (a: never) => Promise<unknown> } }
    await start($ as never)
    await submit($ as never, 'Fix the login bug')
    await $$.tool.call({ tool: 'Edit', file_path: `${CWD}/config.xml`, old_string: 'a', new_string: 'b' } as never)
    await end($ as never)
  }
  test('off by default: exit after work writes no note', async ($, on) => {
    const { files } = setup(on, { store: {} })
    await work($ as never)
    expect(files[NOTE]).toBeUndefined()
  })
  test('/handoff auto shows the setting', async ($, on) => {
    setup(on, { store: {} })
    await start($)
    expect((await $.command.run(run('auto'))).text).toBe('Automatic notes are off: exit saves no note. /handoff auto on turns them on.')
  })
  test('/handoff auto on turns them on, and it lasts', async ($, on) => {
    const { files, store } = setup(on, { store: {} })
    await start($)
    expect((await $.command.run(run('auto on'))).text).toBe('Automatic notes are on: exit saves a quick note when work happened. /handoff auto off turns them off.')
    expect(store.auto).toBe(true)
    await end($)
    await work($ as never)
    expect(files[NOTE]).toContain('> Fix the login bug')
  })
  test('/handoff auto off turns them off', async ($, on) => {
    const { files, store } = setup(on)
    await start($)
    expect((await $.command.run(run('auto off'))).text).toBe('Automatic notes are off: exit saves no note. /handoff auto on turns them on.')
    expect(store.auto).toBe(false)
    await end($)
    await work($ as never)
    expect(files[NOTE]).toBeUndefined()
  })
  test('/handoff auto with another word answers the usage', async ($, on) => {
    setup(on)
    await start($)
    expect((await $.command.run(run('auto maybe'))).text).toBe('Usage: /handoff [show|clear|auto [on|off]]')
  })
  test('a store that fails counts as off, and exit goes on', async ($, on) => {
    const { files } = setup(on, { storeThrows: true })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/config.xml`, old_string: 'a', new_string: 'b' } as never)
    expect(await end($)).toEqual({ sessionId: 's1' })
    expect(files[NOTE]).toBeUndefined()
  })
})
