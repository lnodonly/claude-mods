import { describe, expect, test } from 'claude-code/testing'

import { IMAGE_TOKENS, k, label, measure, report, topItems } from '../hooks/inspect'

const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
const result = (id: string, content: unknown) =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })

describe('label', () => {
  test('Read shows the file name and range', () => {
    expect(label('Read', { file_path: '/proj/config.xml' })).toBe('Read config.xml')
    expect(label('Read', { file_path: '/proj/config.xml', offset: 1, limit: 2000 })).toBe('Read config.xml (lines 1–2000)')
    expect(label('Read', { file_path: '/d/s.csv', offset: 40000 })).toBe('Read s.csv (from line 40000)')
  })
  test('Bash shows the first line of the command', () => {
    expect(label('Bash', { command: 'docker compose up\n--wait' })).toBe('Bash docker compose up')
  })
  test('Grep, Glob and Agent', () => {
    expect(label('Grep', { pattern: 'psk' })).toBe('Grep psk')
    expect(label('Glob', { pattern: '**/*.xml' })).toBe('Glob **/*.xml')
    expect(label('Agent', { description: 'Search configs' })).toBe('Agent Search configs')
  })
  test('other tools show their name', () => {
    expect(label('mcp__x__lookup', { q: 1 })).toBe('mcp__x__lookup')
  })
  test('labels are cut to 60 characters', () => {
    const l = label('Bash', { command: 'x'.repeat(200) })
    expect(l.length).toBe(60)
    expect(l.endsWith('…')).toBe(true)
  })
})

describe('measure', () => {
  test('string and text blocks count characters ÷ 4', () => {
    expect(measure('x'.repeat(400))).toEqual({ tokens: 100, image: false })
    expect(measure([{ type: 'text', text: 'x'.repeat(40) }, { type: 'text', text: 'y'.repeat(40) }])).toEqual({ tokens: 20, image: false })
  })
  test('an image counts as a fixed amount', () => {
    expect(measure([{ type: 'image', source: {} }])).toEqual({ tokens: IMAGE_TOKENS, image: true })
  })
})

describe('topItems', () => {
  test('ranks tool results by size and labels them from their tool_use', () => {
    const msgs = [
      use('a', 'Read', { file_path: '/proj/config.xml' }), result('a', 'x'.repeat(96_400)),
      use('b', 'Bash', { command: 'ls' }), result('b', 'x'.repeat(40)),
      use('c', 'Read', { file_path: '/p/shot.png' }), result('c', [{ type: 'image', source: {} }]),
    ]
    expect(topItems(msgs)).toEqual([
      { label: 'Read config.xml', tokens: 24_100 },
      { label: 'Read shot.png (image)', tokens: IMAGE_TOKENS },
      { label: 'Bash ls', tokens: 10 },
    ])
  })
  test('keeps only the top n', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => [use(`t${i}`, 'Bash', { command: `c${i}` }), result(`t${i}`, 'x'.repeat(4 * (i + 1)))]).flat()
    const top = topItems(msgs)
    expect(top.length).toBe(10)
    expect(top[0]).toEqual({ label: 'Bash c14', tokens: 15 })
  })
  test('a conversation opening on a compaction summary only counts what follows', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'Summary of the earlier conversation...' }] },
      use('z', 'Bash', { command: 'pytest' }), result('z', 'x'.repeat(80)),
    ]
    expect(topItems(msgs)).toEqual([{ label: 'Bash pytest', tokens: 20 }])
  })
  test('a result without its tool_use still counts', () => {
    expect(topItems([result('gone', 'x'.repeat(8))])).toEqual([{ label: 'Tool result', tokens: 2 }])
  })
})

describe('report', () => {
  test('lists items and the saved total', () => {
    const text = report({ items: [{ label: 'Read config.xml', tokens: 24_100 }], saved: 18_400 }, false)
    expect(text).toBe('Biggest items in context (estimated tokens):\n   24.1k  Read config.xml\nOutput cleanup saved ~18.4k tokens this session (on).')
  })
  test('says when nothing is in context and when cleanup is off', () => {
    expect(report({ items: [], saved: 0 }, true)).toBe('No tool results in context yet.\nOutput cleanup saved ~0 tokens this session (off).')
  })
  test('k formats thousands like context-bar', () => {
    expect(k(950)).toBe('950')
    expect(k(24_100)).toBe('24.1k')
    expect(k(120_000)).toBe('120k')
  })
})
