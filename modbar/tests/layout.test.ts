import { describe, expect, test } from 'claude-code/testing'

import type { ModbarBlock } from '../types'
import { arrange, barCells, EMPTY_CONFIG, editConfig, naturalWidth, pack, parseConfig } from '../hooks/layout'

const block = (id: string, width: ModbarBlock['width'], order: number, text = id): ModbarBlock => ({ id, owner: id.split('.')[0]!, order, width, lines: [{ pieces: [{ text }] }] })
const widths = (rows: ReturnType<typeof pack>) => rows.map(r => r.map(c => `${c.block.id}:${c.width}`))

describe('config', () => {
  test('parse: empty, valid, invalid', () => {
    expect(parseConfig('')).toEqual({ config: EMPTY_CONFIG })
    expect(parseConfig('{"order":["a.b"],"blocks":{"a.b":{"width":"half","align":"right","hidden":false}}}')).toEqual({ config: { order: ['a.b'], blocks: { 'a.b': { width: 'half', align: 'right', hidden: false } } } })
    expect(parseConfig('{nope').problem).toMatch(/^not valid JSON/)
    expect(parseConfig('{"blocks":{"a.b":{"width":"wide"}}}')).toEqual({ config: EMPTY_CONFIG, problem: 'a.b: unknown width "wide"' })
    expect(parseConfig('{"order":"a.b"}').problem).toBe('order must be a list of block ids')
    expect(parseConfig('[]').problem).toBe('expected an object')
  })

  test('parse: a block entry that is not an object is a problem, not empty settings', () => {
    for (const v of ['"half"', 'null', '[]', '5', 'true']) {
      expect(parseConfig(`{"blocks":{"a.b":${v}}}`)).toEqual({ config: EMPTY_CONFIG, problem: 'a.b: settings must be an object, like {"width": "half"}' })
    }
    expect(parseConfig('{"blocks":{"a.b":{}}}')).toEqual({ config: { order: [], blocks: { 'a.b': {} } } })
  })

  test('edits', () => {
    let c = editConfig(EMPTY_CONFIG, { id: 'a.b', hidden: true })
    expect(c).toEqual({ order: [], blocks: { 'a.b': { hidden: true } } })
    c = editConfig(c, { id: 'a.b', hidden: false, width: 'half' })
    expect(c.blocks['a.b']).toEqual({ hidden: false, width: 'half' })
    c = editConfig(c, { id: 'c.d', position: 1 })
    c = editConfig(c, { id: 'a.b', position: 1 })
    expect(c.order).toEqual(['a.b', 'c.d'])
    c = editConfig(c, { id: 'c.d', position: 9 })
    expect(c.order).toEqual(['a.b', 'c.d'])
  })
})

describe('arrange', () => {
  test('config order first, then order numbers, then owner and id; hidden dropped; settings applied', () => {
    const blocks = [block('x.one', 'full', 30), block('y.two', 'full', 10), block('z.three', 'half', 20), block('a.hide', 'full', 5)]
    const c = { order: ['z.three'], blocks: { 'a.hide': { hidden: true }, 'y.two': { width: 'half' as const, align: 'right' as const } } }
    const out = arrange(blocks, c)
    expect(out.map(b => b.id)).toEqual(['z.three', 'y.two', 'x.one'])
    expect(out[1]).toMatchObject({ width: 'half', align: 'right' })
  })

  test('a block offered off stays out until the user shows it; the user\'s hide wins over on', () => {
    const off = { ...block('d.top', 'full', 1), off: true }
    expect(arrange([off], EMPTY_CONFIG)).toEqual([])
    expect(arrange([off], { order: [], blocks: { 'd.top': { hidden: false } } }).map(b => b.id)).toEqual(['d.top'])
    expect(arrange([block('d.on', 'full', 1)], { order: [], blocks: { 'd.on': { hidden: true } } })).toEqual([])
  })
})

describe('pack', () => {
  test('halves and thirds share rows; full is alone', () => {
    expect(widths(pack([block('a.1', 'half', 1), block('a.2', 'half', 2), block('a.3', 'full', 3), block('a.4', 'third', 4), block('a.5', 'third', 5), block('a.6', 'third', 6)], 90))).toEqual([
      ['a.1:45', 'a.2:45'], ['a.3:90'], ['a.4:30', 'a.5:30', 'a.6:30'],
    ])
  })

  test('fill takes the rest; a fit joins its row when it fits, else drops', () => {
    const legend = block('cb.legend', 'fill', 11)
    const btn: ModbarBlock = { id: 'h.write', owner: 'h', order: 12, width: 'fit', align: 'right', lines: [{ pieces: [{ button: { key: 'w', label: 'Write handoff note' } }] }] }
    expect(naturalWidth(btn)).toBe(22)
    // One blank column between the fill and its neighbour.
    expect(widths(pack([legend, btn], 100))).toEqual([['cb.legend:77', 'h.write:22']])
    // 20 (fill minimum) + 22 > 40: the button drops to its own row.
    expect(widths(pack([legend, btn], 40))).toEqual([['cb.legend:40'], ['h.write:22']])
  })

  test('a row with no fill puts its spare columns before its first right-aligned block', () => {
    const right = (b: ModbarBlock): ModbarBlock => ({ ...b, align: 'right' })
    const leads = (rows: ReturnType<typeof pack>) => rows.map(r => r.map(c => `${c.block.id}:${c.lead ?? 0}`))
    // A right-aligned fit alone on its row (the legend's row gone or full): pushed to the right end.
    expect(leads(pack([block('cb.legend', 'fill', 11), right(block('h.write', 'fit', 12, 'x'.repeat(22)))], 40))).toEqual([['cb.legend:0'], ['h.write:18']])
    expect(leads(pack([right(block('h.write', 'fit', 12, 'x'.repeat(22)))], 100))).toEqual([['h.write:78']])
    // Only the first right-aligned block takes them; the ones after it follow it to the right.
    expect(leads(pack([block('a.1', 'third', 1), right(block('a.2', 'fit', 2, 'xxxx')), right(block('a.3', 'fit', 3, 'yy'))], 90))).toEqual([['a.1:0', 'a.2:54', 'a.3:0']])
    // A right-aligned half alone sits in the right half.
    expect(leads(pack([right(block('a.1', 'half', 1))], 90))).toEqual([['a.1:45']])
    // Left-aligned rows, rows with a fill, and full rows keep none.
    expect(leads(pack([block('a.1', 'fit', 1, 'xxxx')], 90))).toEqual([['a.1:0']])
    expect(leads(pack([block('a.1', 'fill', 1), right(block('a.2', 'fit', 2, 'xxxx'))], 90))).toEqual([['a.1:0', 'a.2:0']])
    expect(leads(pack([right(block('a.1', 'full', 1))], 90))).toEqual([['a.1:0']])
  })

  test('one fill per row; fit clamps to the width; narrow terminals never go negative', () => {
    expect(widths(pack([block('a.1', 'fill', 1), block('a.2', 'fill', 2)], 100))).toEqual([['a.1:100'], ['a.2:100']])
    expect(widths(pack([block('a.1', 'fit', 1, 'x'.repeat(150))], 100))).toEqual([['a.1:100']])
    for (const w of [1, 10, 19]) {
      const rows = pack([block('a.1', 'half', 1), block('a.2', 'fill', 2), block('a.3', 'third', 3)], w)
      expect(rows.flat().every(c => c.width >= 0 && c.width <= w)).toBe(true)
    }
  })
})

describe('bar', () => {
  test('cells fill the width exactly; a non-empty segment gets at least one cell', () => {
    const segs = [{ value: 2_500 }, { value: 29_100 }, { value: 175 }, { value: 960_000, empty: true }]
    for (const w of [10, 37, 80, 211]) {
      const c = barCells(segs, w)
      expect(c.reduce((a, x) => a + x, 0)).toBe(w)
      expect(c[2]).toBeGreaterThanOrEqual(1)
    }
    expect(barCells([], 10)).toEqual([])
    expect(barCells([{ value: 1 }], 0)).toEqual([0])
  })
})
