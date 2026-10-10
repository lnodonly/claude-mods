import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ModbarBlock } from '../types'
import { emptyCell } from '../hooks/register'

describe('empty cells', () => {
  test('a near-white on light themes, a near-black otherwise', () => {
    expect(emptyCell('light')).toBe('#e4e4e4')
    expect(emptyCell('light-daltonized')).toBe('#e4e4e4')
    expect(emptyCell('dark')).toBe('#262626')
    expect(emptyCell('auto')).toBe('#262626')
    expect(emptyCell(null)).toBe('#262626')
  })
})

const HOME = '/Users/u'
const FILE = `${HOME}/.claude/modbar.json`
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const USAGE: ModbarBlock = { id: 'context-bar.usage', owner: 'context-bar', order: 10, width: 'full', lines: [{ pieces: [{ bar: [{ value: 5, color: 'promptBorder' }, { value: 95, empty: true, dim: true }] }, { text: ' 5% · 45.6k/1000k' }] }] }
const LEGEND: ModbarBlock = { id: 'context-bar.legend', owner: 'context-bar', order: 11, width: 'fill', lines: [{ pieces: [{ text: '■', color: 'promptBorder' }, { text: ' System prompt 2.5k', dim: true }] }] }
const WRITE: ModbarBlock = { id: 'handoff.write', owner: 'handoff', order: 12, width: 'fit', align: 'right', lines: [{ pieces: [{ button: { key: 'handoff-write', label: 'Write handoff note' } }] }] }
const TOP: ModbarBlock = { id: 'example.top', owner: 'example', order: 13, width: 'full', off: true, about: 'biggest items', lines: [{ pieces: [{ text: 'Top: a 3k' }] }] }
const OPEN: ModbarBlock = { id: 'example.x', owner: 'example', order: 50, width: 'full', lines: [{ pieces: [{ button: { key: 'ex-open', label: 'Open' } }] }] }

function setup(on: On, opts: { blocks?: unknown; files?: Record<string, string>; pressed?: () => Promise<void> } = {}) {
  const files: Record<string, string> = { ...(opts.files ?? {}) }
  const ui = { presses: [] as { owner: string; key: string }[], toasts: [] as string[], asked: 0 }
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 0 })
  on('fs.exists', ($, e) => ({ value: e.path in files }) as never)
  on('fs.read', ($, e) => {
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[e.path] } as never
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('ui.toast', ($, e) => {
    ui.toasts.push(e.text)
    return { value: undefined } as never
  })
  // Stands in for the dependents: what their modbar.blocks hooks answer.
  on('modbar.blocks', () => {
    ui.asked++
    return { value: opts.blocks ?? [USAGE, LEGEND, WRITE] } as never
  })
  on('modbar.press', async ($, e) => {
    ui.presses.push({ owner: e.owner, key: e.key })
    await opts.pressed?.()
    return { value: true } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>BENEATH</Text>
  })
  return { files, ui, clock }
}
const start = ($: { session: { start: (a: never) => Promise<unknown> } }) => $.session.start({ cwd: '/x', surface: null, isInteractive: true } as never)
type Mounted = { find: (q: unknown) => Promise<{ text?: string } | undefined>; unmount: () => Promise<void> }
const mount = ($: { ui: { mount: (a: never) => Promise<unknown> } }, props: Partial<typeof BAND.props> = {}) => $.ui.mount({ plugin: 'modbar', surface: 'terminal', ...BAND, props: { ...BAND.props, ...props } } as never) as Promise<Mounted>

describe('drawing', () => {
  test('the bar with its label, the legend and the button on one row, keyed owner:key; beneath kept', async ($, on) => {
    setup(on)
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^[█░]+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 5% · 45.6k/1000k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' System prompt 2.5k' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'handoff:handoff-write', text: 'Write handoff note' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'BENEATH' })).toBeDefined()
    await ui.unmount()
  })

  test('the bar fills what its label leaves', async ($, on) => {
    setup(on, { blocks: [USAGE] })
    await start($)
    const ui = await mount($, { bodyColumns: 60 })
    // Empty cells are full blocks too (in a dim colour), so the bar keeps one height.
    const bar = await ui.find({ type: 'Text', text: /^█+$/ })
    expect(bar?.text?.length).toBe(60 - ' 5% · 45.6k/1000k'.length)
    await ui.unmount()
  })

  test('a survey hides modbar; no blocks draws only what lies beneath', async ($, on) => {
    setup(on)
    await start($)
    const s = await mount($, { hasSurvey: true })
    expect(await s.find({ type: 'Button', key: 'handoff:handoff-write' })).toBeUndefined()
    expect(await s.find({ type: 'Text', text: 'BENEATH' })).toBeDefined()
    await s.unmount()
  })

  test('a right-aligned block alone on its row sits at the right end', async ($, on) => {
    setup(on, { blocks: [WRITE] })
    await start($)
    const ui = await mount($)
    expect((await ui.find({ type: 'Box', key: 'handoff.write' }))?.props).toMatchObject({ width: 22, marginLeft: 78 })
    await ui.unmount()
  })

  test('next to a fill a right-aligned block needs no margin', async ($, on) => {
    setup(on, { blocks: [LEGEND, WRITE] })
    await start($)
    const ui = await mount($)
    expect((await ui.find({ type: 'Box', key: 'handoff.write' }))?.props.marginLeft).toBeUndefined()
    await ui.unmount()
  })

  test('an odd block from a dependent is skipped, the rest still draw', async ($, on) => {
    setup(on, { blocks: [{ id: 'bad' }, null, WRITE] })
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Button', key: 'handoff:handoff-write' })).toBeDefined()
    await ui.unmount()
  })
})

describe('review fixes', () => {
  test('malformed lines and pieces drop that block only', async ($, on) => {
    const bad = (lines: unknown) => ({ id: `x.${Math.random()}`, owner: 'x', order: 1, width: 'full', lines })
    setup(on, { blocks: [bad([undefined]), bad([{ pieces: [{ nope: 1 }] }]), bad([{ pieces: [{ text: 5 }] }]), bad([{ pieces: [{ button: { key: 'k' } }] }]), bad([{ pieces: [{ bar: [{ value: 'x' }] }] }]), WRITE] })
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Button', key: 'handoff:handoff-write' })).toBeDefined()
    await ui.unmount()
  })

  test('consecutive text pieces share one Text, so a long line is cut once at its end', async ($, on) => {
    setup(on, { blocks: [LEGEND] })
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: '■ System prompt 2.5k' })).toBeDefined()
    await ui.unmount()
  })

  test('an invalid file is not overwritten by an edit', async ($, on) => {
    const { files } = setup(on, { files: { [FILE]: '{nope' } })
    await start($)
    expect((await $.command.run(run('modbar', 'hide example.nudge'))).text).toBe('modbar: ~/.claude/modbar.json has a problem, so nothing was changed. Fix it and run /modbar reload, or /modbar reset confirm.')
    expect(files[FILE]).toBe('{nope')
    expect((await $.command.run(run('modbar', 'reset confirm'))).text).toBe('Cleared the modbar settings.')
    expect((await $.command.run(run('modbar', 'hide example.nudge'))).text).toBe('example.nudge: hidden. No mod offers example.nudge now; /modbar lists the ids.')
  })
})

describe('redraw', () => {
  test('the band is redrawn once a minute (for countdowns)', async ($, on) => {
    const { ui, clock } = setup(on)
    await start($)
    const band = await mount($)
    const before = ui.asked
    await clock.advance(60_000)
    expect(ui.asked).toBeGreaterThan(before)
    await band.unmount()
  })

})

describe('/modbar hide|show <mod>', () => {
  test('a mod\'s name hides or shows all its blocks, offered or configured', async ($, on) => {
    const { files } = setup(on, { files: { [FILE]: '{"blocks":{"context-bar.old":{"width":"half"}}}' } })
    await start($)
    expect((await $.command.run(run('modbar', 'hide context-bar'))).text).toBe('context-bar: hidden (context-bar.usage, context-bar.legend, context-bar.old).')
    expect(JSON.parse(files[FILE]!).blocks).toEqual({ 'context-bar.old': { width: 'half', hidden: true }, 'context-bar.usage': { hidden: true }, 'context-bar.legend': { hidden: true } })
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /^█+$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'handoff:handoff-write' })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(run('modbar', 'show context-bar'))).text).toBe('context-bar: shown (context-bar.usage, context-bar.legend, context-bar.old).')
    expect(JSON.parse(files[FILE]!).blocks['context-bar.usage']).toEqual({ hidden: false })
  })

  test('a name with no blocks says so and writes nothing', async ($, on) => {
    const { files } = setup(on)
    await start($)
    expect((await $.command.run(run('modbar', 'hide nobody'))).text).toBe('No blocks from nobody. /modbar lists them.')
    expect(files[FILE]).toBeUndefined()
  })
})

describe('presses', () => {
  test('a press reaches modbar.press with owner and key; a key with : keeps the rest', async ($, on) => {
    const { ui } = setup(on, { blocks: [WRITE, OPEN] })
    await start($)
    const band = await mount($)
    await $.ui.press({ plugin: 'modbar', key: 'handoff:handoff-write' } as never)
    await $.ui.press({ plugin: 'modbar', key: 'example:ex-open' } as never)
    await band.unmount()
    expect(ui.presses).toEqual([{ owner: 'handoff', key: 'handoff-write' }, { owner: 'example', key: 'ex-open' }])
  })

  test('a press whose owner removes the drawing is taken, not passed to a released handle', async ($, on) => {
    let band: Mounted | undefined
    // Like handoff: the press finishes, the button goes, and the drawing holding its handler is gone.
    setup(on, { blocks: [WRITE], pressed: async () => void (await band?.unmount()) })
    await start($)
    band = await mount($)
    expect(await $.ui.press({ plugin: 'modbar', key: 'handoff:handoff-write' } as never)).toEqual({ element: 'handoff:handoff-write' })
  })
})

// Real dependents, loaded beside modbar. The kit writes each out as its own module, so each
// register is self-contained (no names from this file).
const GOOD = {
  name: 'good',
  register: (on: On) => {
    on('modbar.blocks', async ($, e, next) => {
      const r = (await next(e)) as unknown
      const below = Array.isArray(r) ? r : ((r as { value?: unknown[] } | null)?.value ?? [])
      return { value: [...below, { id: 'good.x', owner: 'good', order: 1, width: 'full', lines: [{ pieces: [{ text: 'from good' }, { button: { key: 'go', label: 'Go' } }] }] }] } as never
    })
    // Its press fails.
    on('modbar.press', async ($, e, next) => {
      if (e.owner !== 'good') return next(e)
      throw new Error('good: press failed')
    })
  },
}
const BAD = {
  name: 'bad',
  register: (on: On) => {
    on('modbar.blocks', async ($, e, next) => {
      await next(e)
      throw new Error('bad: blocks failed')
    })
  },
}

describe('a dependent that throws', () => {
  test('its blocks hook is skipped: the other mods\' blocks still draw and /modbar still lists them', { plugins: [GOOD, BAD] }, async ($, on) => {
    setup(on, { blocks: [] })
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'from good' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'BENEATH' })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(run('modbar'))).text).toBe('Shown:\n  good.x · good · full · left · 1')
  })

  test('its press hook is skipped: the press is still taken and the band still draws', { plugins: [GOOD] }, async ($, on) => {
    setup(on, { blocks: [] })
    await start($)
    const ui = await mount($)
    expect(await $.ui.press({ plugin: 'modbar', key: 'good:go' } as never)).toEqual({ element: 'good:go' })
    expect(await ui.find({ type: 'Button', key: 'good:go' })).toBeDefined()
    await ui.unmount()
  })
})

describe('/modbar', () => {
  test('lists what is shown, what can be added and what is configured but not offered', async ($, on) => {
    setup(on, { blocks: [USAGE, LEGEND, WRITE, TOP], files: { [FILE]: '{"blocks":{"example.nudge":{"hidden":true},"context-bar.legend":{"hidden":true}}}' } })
    await start($)
    expect((await $.command.run(run('modbar'))).text).toBe([
      'Shown:',
      '  context-bar.usage · context-bar · full · left · 10',
      '  handoff.write · handoff · fit · right · 12',
      'Can be added (/modbar add <id>):',
      '  context-bar.legend · context-bar · hidden',
      '  example.top · example · biggest items · off by default',
      'Not offered now:',
      '  example.nudge · hidden',
    ].join('\n'))
  })

  test('a block offered off is not drawn until /modbar show, and hide puts it back', async ($, on) => {
    const { files } = setup(on, { blocks: [WRITE, TOP] })
    await start($)
    let ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'Top: a 3k' })).toBeUndefined()
    await ui.unmount()
    expect((await $.command.run(run('modbar', 'show example'))).text).toBe('example: shown (example.top).')
    expect(JSON.parse(files[FILE]!).blocks).toEqual({ 'example.top': { hidden: false } })
    ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'Top: a 3k' })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(run('modbar'))).text).toContain('  example.top · example · full · left · 13')
    expect((await $.command.run(run('modbar', 'hide example.top'))).text).toBe('example.top: hidden.')
    ui = await mount($)
    expect(await ui.find({ type: 'Text', text: 'Top: a 3k' })).toBeUndefined()
    await ui.unmount()
  })

  test('list, add and remove do what /modbar, show and hide do', async ($, on) => {
    const { files } = setup(on, { blocks: [WRITE, TOP] })
    await start($)
    expect((await $.command.run(run('modbar', 'list'))).text).toBe((await $.command.run(run('modbar'))).text)
    expect((await $.command.run(run('modbar', 'add example.top'))).text).toBe('example.top: shown.')
    expect(JSON.parse(files[FILE]!).blocks).toEqual({ 'example.top': { hidden: false } })
    expect((await $.command.run(run('modbar', 'remove example'))).text).toBe('example: hidden (example.top).')
    expect(JSON.parse(files[FILE]!).blocks).toEqual({ 'example.top': { hidden: true } })
  })

  test('a block whose off or about is the wrong type is dropped', async ($, on) => {
    setup(on, { blocks: [{ ...TOP, off: 'yes' }, { ...OPEN, about: 5 }, WRITE] })
    await start($)
    expect((await $.command.run(run('modbar'))).text).toBe('Shown:\n  handoff.write · handoff · fit · right · 12')
  })

  test('edits write the file and apply at once', async ($, on) => {
    const { files } = setup(on)
    await start($)
    expect((await $.command.run(run('modbar', 'width handoff.write half'))).text).toBe('handoff.write: width half.')
    expect(JSON.parse(files[FILE]!)).toEqual({ order: [], blocks: { 'handoff.write': { width: 'half' } } })
    expect((await $.command.run(run('modbar', 'hide context-bar.legend'))).text).toBe('context-bar.legend: hidden.')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: ' System prompt 2.5k' })).toBeUndefined()
    await ui.unmount()
    expect((await $.command.run(run('modbar', 'order handoff.write 1'))).text).toBe('handoff.write: position 1.')
    expect((await $.command.run(run('modbar', 'width handoff.write wide'))).text).toBe('Usage: /modbar [list | reload | reset confirm | add|show <id or mod> | remove|hide <id or mod> | width <id> full|half|third|fit|fill | align <id> left|right | order <id> <n>]')
    expect((await $.command.run(run('modbar', 'reset'))).text).toBe('Type /modbar reset confirm to clear all modbar settings.')
    expect((await $.command.run(run('modbar', 'reset confirm'))).text).toBe('Cleared the modbar settings.')
    expect(JSON.parse(files[FILE]!)).toEqual({ order: [], blocks: {} })
  })

  test('an edit to an id nothing offers or has settings for still applies, and says to check the id', async ($, on) => {
    const { files } = setup(on, { files: { [FILE]: '{"order":["example.placed"],"blocks":{"example.nudge":{"hidden":true}}}' } })
    await start($)
    expect((await $.command.run(run('modbar', 'hide handoff.wrte'))).text).toBe('handoff.wrte: hidden. No mod offers handoff.wrte now; /modbar lists the ids.')
    expect(JSON.parse(files[FILE]!).blocks['handoff.wrte']).toEqual({ hidden: true })
    expect((await $.command.run(run('modbar', 'order other.later 1'))).text).toBe('other.later: position 1. No mod offers other.later now; /modbar lists the ids.')
    expect((await $.command.run(run('modbar', 'width constructor half'))).text).toBe('constructor: width half. No mod offers constructor now; /modbar lists the ids.')
    // Known ids answer as before: offered now (shown or not), or in the file's blocks or order.
    expect((await $.command.run(run('modbar', 'width handoff.write half'))).text).toBe('handoff.write: width half.')
    expect((await $.command.run(run('modbar', 'show example.nudge'))).text).toBe('example.nudge: shown.')
    expect((await $.command.run(run('modbar', 'align example.placed right'))).text).toBe('example.placed: align right.')
  })

  test('an invalid file: one notice, defaults used', async ($, on) => {
    const { ui } = setup(on, { files: { [FILE]: '{nope' } })
    await start($)
    expect(ui.toasts).toEqual([expect.stringMatching(/^modbar: ~\/\.claude\/modbar\.json: not valid JSON .*; using the defaults\.$/)])
    expect((await $.command.run(run('modbar', 'reload'))).text).toMatch(/^modbar: ~\/\.claude\/modbar\.json: not valid JSON/)
  })
})
