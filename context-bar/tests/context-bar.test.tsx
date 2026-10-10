import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { afterCompaction, blocksFor } from '../hooks/register'

// The blocks themselves, through blocksFor; the hooks that feed and answer modbar are under "through modbar".
const SNAP = {
  segments: [
    { name: 'System prompt', tokens: 10_000, color: 'promptBorder', kind: 'used' as const },
    { name: 'Messages', tokens: 50_000, color: 'permission', kind: 'used' as const },
    { name: 'Autocompact buffer', tokens: 40_000, color: 'inactive', kind: 'buffer' as const },
    { name: 'Free space', tokens: 100_000, color: 'inactive', kind: 'free' as const },
  ],
  total: 60_000,
  max: 200_000,
  percent: 30,
}

describe('context-bar', () => {
  test('the usage block is the bar then the label; the legend is a fill block', () => {
    const blocks = blocksFor(SNAP)
    expect(blocks.map(b => [b.id, b.width, b.order])).toEqual([['context-bar.usage', 'full', 10], ['context-bar.legend', 'fill', 11]])
    const [usage, legend] = blocks
    expect(usage!.lines[0]!.pieces).toEqual([
      { bar: [{ value: 10_000, color: 'promptBorder' }, { value: 50_000, color: 'permission' }, { value: 40_000, color: undefined, dim: true, empty: true }, { value: 100_000, color: undefined, dim: true, empty: true }] },
      { text: ' 30% · 60.0k/200k' },
    ])
    expect(legend!.lines[0]!.pieces).toEqual([
      { text: '■', color: 'promptBorder' }, { text: ' System 10.0k  ', dim: true },
      { text: '■', color: 'permission' }, { text: ' Messages 50.0k  ', dim: true },
    ])
  })

  test('long category names are shortened in the legend', () => {
    const named = (name: string) => ({ name, tokens: 1_000, color: 'permission', kind: 'used' as const })
    const names = ['System prompt', 'System tools', 'MCP server instructions', 'Memory files', 'Skills']
    const legend = blocksFor({ ...SNAP, segments: names.map(named) })[1]!
    expect(legend.lines[0]!.pieces.filter((_, i) => i % 2 === 1).map(p => (p as { text: string }).text)).toEqual([' System 1.0k  ', ' Tools 1.0k  ', ' MCP 1.0k  ', ' Memories 1.0k  ', ' Skills 1.0k  '])
  })

  test('nothing to show before the first measurement', () => {
    expect(blocksFor(null)).toEqual([])
    expect(blocksFor({ ...SNAP, segments: [] })).toEqual([])
  })
  test('after a compaction Messages shrinks to the new size and free space takes the rest', () => {
    const out = afterCompaction(SNAP.segments, 15_000)
    expect(out.map(s => [s.name, s.tokens])).toEqual([['System prompt', 10_000], ['Messages', 5_000], ['Autocompact buffer', 40_000], ['Free space', 145_000]])
    // A figure under the other rows (or over the old size) never makes Messages negative or larger.
    expect(afterCompaction(SNAP.segments, 4_000).map(s => s.name)).toEqual(['System prompt', 'Autocompact buffer', 'Free space'])
    expect(afterCompaction(SNAP.segments, 90_000)).toEqual(SNAP.segments)
  })
})

// modbar in a test: an inline plugin adds the noun as modbar does (its core here answers one
// block of another mod) and a command that answers what $.modbar.blocks gives, so context-bar's
// own modbar.blocks hook runs. The test's own $ carries no plugin's noun.
const MODBAR = {
  name: 'modbar',
  register: (on: On) => {
    on('engine.create', async ($, e, next) => ({ ...(await next(e)), modbar: { blocks: async () => [{ id: 'other.x', owner: 'other', order: 1, width: 'fit', lines: [] }], press: async () => false } }) as never)
    on('command.run', { command: 'blocks' }, async $ => ({ text: JSON.stringify(await $.modbar.blocks({ columns: 100 })) }))
  },
}
type Block = { id: string; lines: { pieces: { text?: string }[] }[] }
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 10_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 50_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Tool schemas', tokens: 7_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 140_000, color: 'inactive', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 60_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 30,
}

const SAID = [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }]

function setup(on: On) {
  let redrawn = () => {}
  const seen = { reads: 0, redraw: new Promise<void>(r => (redrawn = r)) }
  on('session.usage', () => {
    seen.reads++
    return { value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: [] } } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.compact', () => ({ messages: SAID, tokensAfter: 15_000 }) as never)
  on('ui.invalidate', ($, e, next) => {
    redrawn()
    return next(e)
  })
  return seen
}
const blocks = async ($: { command: { run: (a: never) => Promise<{ text: string }> } }) =>
  JSON.parse((await $.command.run({ command: 'blocks', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)).text) as Block[]
const reply = ($: { turn: { complete: (a: never) => Promise<unknown> } }) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', category: null, explanation: null } as never)
const label = (bs: Block[]) => bs.find(b => b.id === 'context-bar.usage')?.lines[0]?.pieces[1]?.text

describe('through modbar', () => {
  test('after a reply its hook adds the bar and legend after the blocks beneath; deferred rows are left out', { plugins: [MODBAR] }, async ($, on) => {
    setup(on)
    await reply($)
    const bs = await blocks($)
    expect(bs.map(b => b.id)).toEqual(['other.x', 'context-bar.usage', 'context-bar.legend'])
    expect(label(bs)).toBe(' 30% · 60.0k/200k')
    expect(JSON.stringify(bs)).not.toContain('Tool schemas')
  })

  test('with nothing measured (after /clear) the first draw has no bar and starts a read; the redraw has it', { plugins: [MODBAR] }, async ($, on) => {
    const seen = setup(on)
    expect((await blocks($)).map(b => b.id)).toEqual(['other.x'])
    await seen.redraw
    expect(seen.reads).toBe(1)
    expect(label(await blocks($))).toBe(' 30% · 60.0k/200k')
  })

  test('after /compact Messages shrinks to the compacted size at once; a precompute changes nothing', { plugins: [MODBAR] }, async ($, on) => {
    setup(on)
    await reply($)
    await $.session.compact({ trigger: 'precompute', messages: SAID } as never)
    expect(label(await blocks($))).toBe(' 30% · 60.0k/200k')
    await $.session.compact({ trigger: 'manual', messages: SAID } as never)
    expect(label(await blocks($))).toBe(' 8% · 15.0k/200k')
  })
})
