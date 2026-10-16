import { describe, expect, test } from 'claude-code/testing'

import { commandPaths, mentionedFiles, staticPrefix } from '../hooks/rules'
import { ROOT, RULES_JSON, setup } from './fixtures'

const RULES = `${ROOT}/.claude/rules.json`
const TEMPLATE = `${ROOT}/config/templates/home.html`
const SCHEMA = `${ROOT}/config/schema.json`
const DOC = `${ROOT}/docs/style-guide.md`

// A tiny disk: files with mtimes; a Bash "write" bumps a file's mtime.
function disk() {
  const files: Record<string, string> = { [RULES]: RULES_JSON, [TEMPLATE]: '', [SCHEMA]: '{}', [DOC]: '' }
  const mtimes: Record<string, number> = {}
  const touch = (p: string) => (mtimes[p] = (mtimes[p] ?? 1) + 1)
  return { files, mtime: (p: string) => mtimes[p] ?? 1, touch }
}

describe('rules helpers for Bash', () => {
  test('staticPrefix stops at the first wildcard segment', async () => {
    expect(staticPrefix('config/templates/*.html')).toBe('config/templates')
    expect(staticPrefix('config/schema.json')).toBe('config/schema.json')
    expect(staticPrefix('**/schema.json')).toBe('')
  })
  test('mentionedFiles finds files a command names by path or file name', async () => {
    const rels = ['config/schema.json', 'config/templates/home.html']
    expect(mentionedFiles("python3 - <<'PY'\nopen('schema.json')", rels)).toEqual(['config/schema.json'])
    expect(mentionedFiles('sed -i s/a/b/ config/templates/home.html', rels)).toEqual(['config/templates/home.html'])
    expect(mentionedFiles('ls', rels)).toEqual([])
  })

  // Backlog #24: where a command works, besides the session's folder.
  test('commandPaths: cd and pushd targets, in order, relative to the folder the command is in by then', async () => {
    expect(commandPaths('cd /p && ls', '/a', '/h')).toEqual(['/p'])
    expect(commandPaths('cd sub; cd ../q && pushd /r', '/a', '/h')).toEqual(['/a/sub', '/a/q', '/r'])
    expect(commandPaths('cd -P ../p', '/a/b', '/h')).toEqual(['/a/p'])
    expect(commandPaths('cd && ls', '/a', '/h')).toEqual(['/h'])
  })
  test('commandPaths: absolute, home and parent paths anywhere in the command', async () => {
    expect(commandPaths('cat /p/config/schema.json', '/a', '/h')).toEqual(['/p/config/schema.json'])
    expect(commandPaths('cat ~/p/x $HOME/q ${HOME}/r ~', '/a', '/h')).toEqual(['/h/p/x', '/h/q', '/h/r', '/h'])
    expect(commandPaths('ls ../p ..', '/a/b', '/h')).toEqual(['/a/p', '/a'])
    expect(commandPaths('tool --out=/p/x PYTHONPATH=/q', '/a', '/h')).toEqual(['/p/x', '/q'])
    expect(commandPaths('ls /p/config/templates/*.html', '/a', '/h')).toEqual(['/p/config/templates'])
    expect(commandPaths('cd /p && sed -i s/a/b/ config/schema.json', '/a', '/h')).toEqual(['/p', '/p/s/a/b', '/p/config/schema.json'])
  })
  test('commandPaths: quoted paths, wrappers and heredocs', async () => {
    expect(commandPaths('cd "/my proj" && ls', '/a', '/h')).toContain('/my proj')
    expect(commandPaths('bash -c "cd /p && make"', '/a', '/h')).toContain('/p')
    expect(commandPaths(`bash -c "sh -c 'zsh -c \\"cd /p && make\\"'"`, '/a', '/h')).toContain('/p')
    expect(commandPaths("python3 - <<'PY'\n# don't\nopen('/p/config/schema.json')\nPY", '/a', '/h')).toContain('/p/config/schema.json')
  })
  test('commandPaths: every path is returned, however many there are', async () => {
    const junk = Array.from({ length: 600 }, (_, i) => `/j${i}/x x${i}/y`).join(' ')
    const out = commandPaths(`python3 - <<'PY'\n${junk}\nPY\ncat /p/config/schema.json`, '/a', '/h')
    expect(out).toHaveLength(1201)
    expect(out.at(-1)).toBe('/p/config/schema.json')
  })
  test('commandPaths: nothing for variables, URLs or a missing home', async () => {
    expect(commandPaths('echo $FOO/bar `pwd`/x', '/a', '/h')).toEqual([])
    expect(commandPaths('curl https://example.com/a/b', '/a', '/h')).toEqual([])
    expect(commandPaths('cat ~/x', '/a', undefined)).toEqual([])
    expect(commandPaths('ls -la', '/a', '/h')).toEqual([])
  })
})

describe('Bash edits', () => {
  test('a template changed by a Bash script owes its doc; a doc changed by Bash pays it', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime, onBash: c => (c.includes('fix-template') ? d.touch(TEMPLATE) : c.includes('fix-doc') ? d.touch(DOC) : 0) })
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call({ tool: 'Bash', command: 'python3 fix-template.py' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/config\/templates\/home\.html/)
    await $.tool.call({ tool: 'Bash', command: 'python3 fix-doc.py' })
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  })

  test('a Bash command naming a gated file needs the skill', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime })
    const denied = await $.tool.call({ tool: 'Bash', command: "python3 - <<'PY'\ns=open('config/schema.json').read()\nPY" })
    expect(denied.deny).toMatch(/load the `schema-rules` skill/)
    expect(denied.deny).toMatch(/config\/schema\.json/)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    expect((await $.tool.call({ tool: 'Bash', command: 'cat config/schema.json' })).deny).toBeUndefined()
  })

  test('a gated file changed indirectly without the skill gets a note to Claude', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime, onBash: () => d.touch(SCHEMA) })
    const ran = await $.tool.call({ tool: 'Bash', command: 'python3 build.py' })
    expect(ran.deny).toBeUndefined()
    const notes = ((ran as { context?: readonly string[] }).context ?? []).join('\n')
    expect(notes).toMatch(/config\/schema\.json/)
    expect(notes).toMatch(/schema-rules/)
  })

  test('Bash outside a rules project is untouched', async ($, on) => {
    setup(on, {}, { cwd: '/nowhere' })
    expect((await $.tool.call({ tool: 'Bash', command: 'cat schema.json' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'cd /tmp && cat schema.json /usr/share/x' })).deny).toBeUndefined()
  })
})

// Backlog #24: a command that works in another rules project is checked by that project's rules.
describe('commands that work in another rules project', () => {
  test('a cd into the project, or a path into it, needs the skill as a command run there does', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime, cwd: '/elsewhere' })
    expect((await $.tool.call({ tool: 'Bash', command: 'cd /p && head -1 config/schema.json' })).deny).toMatch(/load the `schema-rules` skill/)
    expect((await $.tool.call({ tool: 'Bash', command: 'cat /p/config/schema.json' })).deny).toMatch(/config\/schema\.json/)
    expect((await $.tool.call({ tool: 'Bash', command: 'cd ../p && cat config/schema.json' })).deny).toMatch(/schema-rules/)
    expect((await $.tool.call({ tool: 'Bash', command: 'migrate status --path=/p' })).deny).toMatch(/db-migrations/)
    expect((await $.tool.call({ tool: 'Bash', command: 'cd /p && ls' })).deny).toBeUndefined()
  })

  // A guard must not drop inputs: a gated path named after hundreds of others is still checked.
  test('a gated path named last, after more paths than any cap, still needs the skill', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime, cwd: '/elsewhere' })
    const junk = Array.from({ length: 600 }, (_, i) => `/j${i}/x x${i}/y`).join(' ')
    const command = `python3 - <<'PY'\n${junk}\nPY\ncat /p/config/schema.json`
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toMatch(/load the `schema-rules` skill/)
  })

  test('a home-relative cd finds the project too', async ($, on) => {
    setup(on, { '/h/proj/.claude/rules.json': RULES_JSON, '/h/proj/config/schema.json': '{}' }, { cwd: '/elsewhere', home: '/h' })
    expect((await $.tool.call({ tool: 'Bash', command: 'cd ~/proj && cat config/schema.json' })).deny).toMatch(/schema-rules/)
  })

  test('files it changes there are seen: a note for a gated file, and docs owed at Stop', async ($, on) => {
    const d = disk()
    setup(on, d.files, { mtime: d.mtime, cwd: '/elsewhere', onBash: () => (d.touch(SCHEMA), d.touch(TEMPLATE)) })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    const ran = await $.tool.call({ tool: 'Bash', command: 'cd /p && python3 build.py' })
    expect(ran.deny).toBeUndefined()
    expect(((ran as { context?: readonly string[] }).context ?? []).join('\n')).toMatch(/changed config\/schema\.json/)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/config\/templates\/home\.html/)
  })
})

describe('block rules', () => {
  const BLOCK = JSON.stringify({ block: [{ commands: ['deploy\\.sh'], reason: 'Builds run through CI.' }, { paths: ['secrets/**'], reason: 'Hands off.' }] })

  test('a blocked command is refused with the reason, before it runs; others run', async ($, on) => {
    const ran: string[] = []
    setup(on, { [RULES]: BLOCK }, { onBash: c => ran.push(c) })
    const r = (await $.tool.call({ tool: 'Bash', command: 'python3 -u deploy.sh --force' })) as { deny?: string }
    expect(r.deny).toBe("Project rule (.claude/rules.json) blocks that command: Builds run through CI. Don't try to do it another way.")
    await $.tool.call({ tool: 'Bash', command: 'python3 report.py' })
    expect(ran).toEqual(['python3 report.py'])
  })

  test('an edit to a blocked path is refused', async ($, on) => {
    setup(on, { [RULES]: BLOCK })
    const r = (await $.tool.call({ tool: 'Write', file_path: `${ROOT}/secrets/key.txt`, content: 'x' })) as { deny?: string }
    expect(r.deny).toBe("Project rule (.claude/rules.json) blocks editing secrets/key.txt: Hands off. Don't try to do it another way.")
  })

  test('a block rule applies to a command run there from another folder (#24)', async ($, on) => {
    const ran: string[] = []
    setup(on, { [RULES]: BLOCK }, { cwd: '/elsewhere', onBash: c => ran.push(c) })
    expect((await $.tool.call({ tool: 'Bash', command: 'cd /p && python3 deploy.sh' })).deny).toMatch(/Builds run through CI/)
    expect((await $.tool.call({ tool: 'Bash', command: 'bash -c "cd /p; python3 deploy.sh"' })).deny).toMatch(/through CI/)
    await $.tool.call({ tool: 'Bash', command: 'python3 deploy.sh' })
    expect(ran).toEqual(['python3 deploy.sh'])
  })

  test('/rules off pauses blocking too; /rules counts block rules', async ($, on) => {
    const ran: string[] = []
    setup(on, { [RULES]: BLOCK }, { onBash: c => ran.push(c) })
    expect((await $.command.run({ command: 'rules', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)).text).toContain('block rules: 2')
    await $.command.run({ command: 'rules', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    await $.tool.call({ tool: 'Bash', command: 'python3 deploy.sh' })
    expect(ran).toEqual(['python3 deploy.sh'])
  })
})

// Backlog #144: the after-the-fact scan stops at 5,000 entries; Claude is told once per rules file.
describe('the change scan stops at its cap', () => {
  const CAP = 5000
  const TEMPLATES = `${ROOT}/config/templates`
  // `n` files in the watched folder (a skill rule watches config/templates/**).
  const many = (dir: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.html`, '']))
  const notesOf = (ran: unknown) => ((ran as { context?: readonly string[] }).context ?? []).join('\n')
  const NOTE = (rules: string) =>
    `rules-enforcer: the paths ${rules} watches hold more than 5,000 files and folders, so files Bash commands change are checked only in part. Edits made with Edit or Write are still checked.`

  test('the first Bash call that hits the cap gets the note, once; nothing is refused', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, CAP + 1) })
    const first = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as { deny?: string; result?: string }
    expect(first.deny).toBeUndefined()
    expect(first.result).toBe('ok')
    expect((first as { context?: readonly string[] }).context).toEqual([NOTE(RULES)])
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'pwd' }))).toBe('')
  })

  test('exactly the cap is a complete scan; one more is not', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, CAP) })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
  })

  test('a nested folder that fills the cap exactly is a complete scan too', async ($, on) => {
    // One folder entry plus CAP - 1 files inside it.
    const files = { [RULES]: RULES_JSON, ...many(`${TEMPLATES}/a`, CAP - 1) }
    setup(on, files)
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
  })

  test('a scan under the cap says nothing', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, 50) })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
  })

  test('a cut-short scan still sees the changes it reached, and the note comes with the change note', async ($, on) => {
    const d = disk()
    setup(on, { ...d.files, ...many(TEMPLATES, CAP + 1) }, { mtime: d.mtime, onBash: () => d.touch(SCHEMA) })
    const notes = notesOf(await $.tool.call({ tool: 'Bash', command: 'python3 build.py' }))
    expect(notes).toMatch(/that command changed config\/schema\.json/)
    expect(notes).toContain(NOTE(RULES))
  })

  test('each rules file is told once: another project over the cap gets its own note', async ($, on) => {
    const OTHER = '/q/.claude/rules.json'
    setup(on, { [RULES]: RULES_JSON, [OTHER]: RULES_JSON, ...many(TEMPLATES, 10), ...many('/q/config/templates', CAP + 1) })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'cd /q && ls' }))).toBe(NOTE(OTHER))
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'cd /q && ls' }))).toBe('')
  })

  test('a refused call does not use up the note', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, CAP + 1) })
    expect((await $.tool.call({ tool: 'Bash', command: 'migrate status' })).deny).toMatch(/db-migrations/)
    await $.tool.call({ tool: 'Skill', skill: 'db-migrations' })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'migrate status' }))).toBe(NOTE(RULES))
  })

  test('/clear forgets that it was said', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, CAP + 1) })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(NOTE(RULES))
    await $.classic.SessionEnd({ reason: 'clear' })
    expect(notesOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe(NOTE(RULES))
  })

  test('edits through Edit and Write are not scanned, so they get no note', async ($, on) => {
    setup(on, { [RULES]: RULES_JSON, ...many(TEMPLATES, CAP + 1) })
    expect(notesOf(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: 'x' }))).toBe('')
  })
})
