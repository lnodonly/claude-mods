import { describe, expect, test } from 'claude-code/testing'

import { afterCompaction, blocksFor } from '../hooks/register'

// A test can't call $.modbar (modbar isn't loaded, and the engine allows a module only the calls its
// source makes), so the blocks are checked through blocksFor, which the modbar.blocks hook wraps.
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
