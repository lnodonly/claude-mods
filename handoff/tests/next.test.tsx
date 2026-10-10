import { describe, expect, mock, test } from 'claude-code/testing'

import { blocksFor } from '../hooks/register'
import type { On } from 'claude-code'

const HOME = '/Users/u'
const CWD = '/Users/u/Repository/my-project'
const NOTE = `${HOME}/.claude/handoffs/-Users-u-Repository-my-project-0af20ff9.md`
const STEPS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']
const TEXT = `# Handoff · my-project · 2026-10-07 21:40 · full\n\n## Next steps\n\n${STEPS.map(s => `- [ ] ${s}`).join('\n')}\n`

function setup(on: On, files: Record<string, string>) {
  const ui = { suggested: [] as string[], toasts: [] as string[], forks: 0 }
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('model.fork', () => {
    ui.forks++
    return { value: { isAnswered: true, text: '## Done\n\nX.\n\n## Next steps\n\n- [ ] Check Y\n' } } as never
  })
  on('ui.toast', ($, e) => {
    ui.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('prompt.submit', ($, e) => ({ text: (e as { text: string }).text }) as never)
  mock.env(on, { HOME })
  mock.clock(on, { now: 0 })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('prompt.suggest', ($, e) => {
    ui.suggested.push(e.text)
    return { isShown: true } as never
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }) as never)
  // modbar isn't loaded in a test: its noun, as modbar provides it.
  on('engine.create', async ($, e, next) => ({ ...(await next(e)), modbar: { blocks: async () => [], press: async () => false } }) as never)
  return ui
}
const start = ($: { session: { start: (a: never) => Promise<unknown> } }) => $.session.start({ cwd: CWD, surface: null, isInteractive: true } as never)

// A test can't call $.modbar, so the blocks are checked through blocksFor (the hook wraps it).
const state = (over: Partial<Parameters<typeof blocksFor>[0]> = {}) => ({ worked: false, writing: false, interactive: true, ...over })

describe('blocks', () => {
  test('nothing until the session has done work: the previous note is context, not drawn', () => {
    expect(blocksFor(state())).toEqual([])
  })

  test('after work: the Write handoff note button, fit and right-aligned; while writing it says so', () => {
    expect(blocksFor(state({ worked: true }))).toEqual([{ id: 'handoff.write', owner: 'handoff', order: 13, width: 'fit', align: 'right', lines: [{ pieces: [{ button: { key: 'handoff-write', label: 'Write handoff note' } }] }] }])
    expect(blocksFor(state({ worked: true, writing: true }))[0]!.lines[0]!.pieces).toEqual([{ button: { key: 'handoff-write', label: 'Writing handoff note…' } }])
    expect(blocksFor(state({ worked: true, interactive: false }))).toEqual([])
  })
})

describe('next session', () => {
  test('Claude gets the note; nothing is suggested in the prompt box', async ($, on) => {
    const ui = setup(on, { [NOTE]: TEXT })
    await start($)
    expect(ui.suggested).toEqual([])
    const ctx = (await $.prompt.context({ blocks: [] } as never)) as { blocks: { name: string; text: string }[] }
    expect(ctx.blocks).toEqual([{ name: 'handoff', text: `Handoff note from the previous session in this folder (full, 2026-10-07 21:40):\n\n${TEXT}` }])
  })
  test('no note: no suggestion, no context block', async ($, on) => {
    const ui = setup(on, {})
    await start($)
    expect(ui.suggested).toEqual([])
    expect(((await $.prompt.context({ blocks: [] } as never)) as { blocks: unknown[] }).blocks).toEqual([])
  })
})
