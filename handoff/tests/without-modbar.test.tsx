import { describe, expect, mock, test } from 'claude-code/testing'

// Nothing stands in for modbar here: handoff adds modbar's noun itself, so it loads and keeps its
// notes and command with no modbar loaded (only its button goes undrawn).
const HOME = '/Users/u'
const CWD = '/Users/u/Repository/my-project'
const NOTE = `${HOME}/.claude/handoffs/-Users-u-Repository-my-project-0af20ff9.md`
const TEXT = '# Handoff · my-project · 2026-10-06 09:00 · full\n\nhello\n'

describe('without modbar', () => {
  test('with no modbar loaded it loads, and /handoff shows the note', async ($, on) => {
    const files: Record<string, string> = { [NOTE]: TEXT }
    mock.env(on, { HOME })
    mock.clock(on, { now: 0 })
    mock.store(on)
    on('fs.exists', ($, e) => ({ value: e.path in files }))
    on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }) as never)
    on('fs.list', () => ({ value: [] }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
    on('session.cwd', () => ({ value: CWD }) as never)
    on('session.root', () => ({ value: CWD }) as never)
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    await $.session.start({ cwd: CWD, surface: null, isInteractive: true } as never)
    const r = await $.command.run({ command: 'handoff', args: 'show', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(r.text).toBe(TEXT)
  })
})
