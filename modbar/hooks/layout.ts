// Modbar's layout, on plain data: no engine imports.
import type { ModbarAlign, ModbarBlock, ModbarConfig, ModbarPiece, ModbarSettings, ModbarWidth } from '../types'

export type Config = ModbarConfig
export const EMPTY_CONFIG: Config = { order: [], blocks: {} }
export const MIN_FILL = 20
export const FILL_GAP = 1
const WIDTHS: readonly ModbarWidth[] = ['full', 'half', 'third', 'fit', 'fill']

const bad = (problem: string) => ({ config: EMPTY_CONFIG, problem })

export function parseConfig(text: string): { config: Config; problem?: string } {
  if (text.trim() === '') return { config: EMPTY_CONFIG }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return bad(`not valid JSON (${(err as Error).message})`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('expected an object')
  const r = raw as { order?: unknown; blocks?: unknown }
  if (r.order !== undefined && !(Array.isArray(r.order) && r.order.every(x => typeof x === 'string'))) return bad('order must be a list of block ids')
  const blocks: Record<string, ModbarSettings> = {}
  if (r.blocks !== undefined) {
    if (typeof r.blocks !== 'object' || r.blocks === null || Array.isArray(r.blocks)) return bad('blocks must be an object')
    for (const [id, v] of Object.entries(r.blocks as Record<string, unknown>)) {
      const b = (v ?? {}) as { width?: unknown; align?: unknown; hidden?: unknown }
      if (b.width !== undefined && !WIDTHS.includes(b.width as ModbarWidth)) return bad(`${id}: unknown width "${String(b.width)}"`)
      if (b.align !== undefined && b.align !== 'left' && b.align !== 'right') return bad(`${id}: align must be left or right`)
      if (b.hidden !== undefined && typeof b.hidden !== 'boolean') return bad(`${id}: hidden must be true or false`)
      blocks[id] = {
        ...(b.width !== undefined ? { width: b.width as ModbarWidth } : {}),
        ...(b.align !== undefined ? { align: b.align as ModbarAlign } : {}),
        ...(b.hidden !== undefined ? { hidden: b.hidden as boolean } : {}),
      }
    }
  }
  return { config: { order: (r.order as string[] | undefined) ?? [], blocks } }
}

export type Change = { id: string; width?: ModbarWidth; align?: ModbarAlign; hidden?: boolean; position?: number }

export function editConfig(c: Config, change: Change): Config {
  const { id, position, ...settings } = change
  const blocks = Object.keys(settings).length > 0 ? { ...c.blocks, [id]: { ...(c.blocks[id] ?? {}), ...settings } } : c.blocks
  let order = c.order
  if (position !== undefined) {
    const rest = order.filter(x => x !== id)
    const at = Math.max(0, Math.min(rest.length, position - 1))
    order = [...rest.slice(0, at), id, ...rest.slice(at)]
  }
  return { order, blocks }
}

const LAST = Number.MAX_SAFE_INTEGER

// The user's hide or show wins; with neither, a block the mod offers as off stays hidden.
export const isHidden = (b: ModbarBlock, c: Config) => c.blocks[b.id]?.hidden ?? b.off === true

export function arrange(blocks: ModbarBlock[], c: Config): ModbarBlock[] {
  const pos = (id: string) => (c.order.includes(id) ? c.order.indexOf(id) : LAST)
  return blocks
    .filter(b => !isHidden(b, c))
    .map(b => {
      const s = c.blocks[b.id] ?? {}
      return { ...b, ...(s.width ? { width: s.width } : {}), ...(s.align ? { align: s.align } : {}) }
    })
    .sort((a, b) => pos(a.id) - pos(b.id) || a.order - b.order || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id))
}

export const pieceWidth = (p: ModbarPiece) => ('text' in p ? p.text.length : 'button' in p ? p.button.label.length + 4 : 0)
export const naturalWidth = (b: ModbarBlock) => Math.max(0, ...b.lines.map(l => l.pieces.reduce((a, p) => a + pieceWidth(p), 0)))

export type Cell = { block: ModbarBlock; width: number }
export type Row = Cell[]

export function pack(blocks: ModbarBlock[], columns: number): Row[] {
  const C = Math.max(0, columns)
  const fixed = (b: ModbarBlock) => {
    switch (b.width) {
      case 'full': return C
      case 'half': return Math.floor(C / 2)
      case 'third': return Math.floor(C / 3)
      case 'fit': return Math.min(naturalWidth(b), C)
      default: return Math.min(MIN_FILL, C)
    }
  }
  const rows: Row[] = []
  let cur: Row = []
  const used = (row: Row) => row.reduce((a, c) => a + fixed(c.block), 0)
  for (const b of blocks) {
    const fits = cur.length > 0
      && b.width !== 'full'
      && !cur.some(c => c.block.width === 'full')
      && !(b.width === 'fill' && cur.some(c => c.block.width === 'fill'))
      && used(cur) + fixed(b) + (b.width === 'fill' || cur.some(c => c.block.width === 'fill') ? FILL_GAP * cur.length : 0) <= C
    if (!fits && cur.length > 0) {
      rows.push(cur)
      cur = []
    }
    cur.push({ block: b, width: fixed(b) })
  }
  if (cur.length > 0) rows.push(cur)
  // A fill takes what the others on its row leave, less one blank column between each pair (FILL_GAP).
  for (const row of rows) {
    const fill = row.find(c => c.block.width === 'fill')
    if (fill) fill.width = Math.max(Math.min(MIN_FILL, C), C - row.filter(c => c !== fill).reduce((a, c) => a + c.width, 0) - FILL_GAP * (row.length - 1))
  }
  return rows
}

// Largest-remainder split of `width` cells, so a bar always fills exactly; a non-empty
// segment gets at least one cell, taken from the largest other segment.
export function barCells(segments: { value: number; empty?: boolean }[], width: number): number[] {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0)
  if (total <= 0 || width <= 0) return segments.map(() => 0)
  const exact = segments.map(s => (Math.max(0, s.value) / total) * width)
  const out = exact.map(Math.floor)
  let left = width - out.reduce((a, x) => a + x, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i]! += 1
    left -= 1
  }
  segments.forEach((s, i) => {
    if (!s.empty && s.value > 0 && out[i] === 0) {
      const from = out.reduce((best, x, j) => (j !== i && x > 1 && x > (out[best] ?? 0) ? j : best), -1)
      if (from >= 0) {
        out[from]! -= 1
        out[i] = 1
      }
    }
  })
  return out
}
