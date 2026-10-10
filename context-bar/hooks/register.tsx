import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Segment, Snapshot } from '../types'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)

// Hidden or shown with /modbar hide|show context-bar (one block or both), not a command of its own.

// `compacted`: the conversation's size after a compaction. Until the next response the engine's
// Messages row still holds the size before it, so that row is swapped for this one.
async function refresh($: EngineInterface, compacted?: number) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return
  let segments: Segment[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind as Segment['kind'] }))
  let total = b.totalTokens
  if (compacted !== undefined) segments = afterCompaction(segments, compacted)
  if (compacted !== undefined) total = segments.filter(s => s.kind === 'used').reduce((n, s) => n + s.tokens, 0)
  const percent = compacted === undefined ? b.percentage : Math.round((total / b.rawMaxTokens) * 100)
  const next: Snapshot = { segments, total, max: b.rawMaxTokens, percent }
  await update($, snapshot, () => next)
}

// The engine's doc names the Messages row as the one reconciled to the last response.
// `after` counts the whole window (its `tokensBefore` matches the window's total), so the
// rest of the used rows come off it; what Messages gives up goes back to free space.
export function afterCompaction(segments: Segment[], after: number): Segment[] {
  const msgs = segments.find(s => s.name === 'Messages')
  if (!msgs) return segments
  const rest = segments.filter(s => s.kind === 'used' && s !== msgs).reduce((n, s) => n + s.tokens, 0)
  const tokens = Math.max(0, Math.min(msgs.tokens, after - rest))
  const freed = msgs.tokens - tokens
  const free = segments.find(s => s.kind === 'free')
  const out = segments
    .map(s => (s === msgs ? { ...s, tokens } : s === free ? { ...s, tokens: s.tokens + freed } : s))
    .filter(s => s.tokens > 0)
  return free || freed === 0 ? out : [...out, { name: 'Free space', tokens: freed, color: 'inactive', kind: 'free' }]
}

// One read at a time; a failed read leaves the last bar and is tried again at the next draw.
let reading: Promise<void> | null = null
function refreshSoon($: EngineInterface) {
  reading ??= refresh($)
    .then(() => $.ui.invalidate('ui.render'))
    .catch(() => {})
    .finally(() => {
      reading = null
    })
}

// A hook on a mod's noun gets and answers { value } (modbar's calls).
const valueOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { value?: unknown[] } | null)?.value ?? []))
const answer = (v: unknown) => ({ value: v }) as never

// Shorter legend names for the engine's longer categories.
const SHORT: Record<string, string> = {
  'System prompt': 'System',
  'System tools': 'Tools',
  'MCP server instructions': 'MCP',
  'Memory files': 'Memories',
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`)

// What modbar draws: the bar with its percentage on one line, and the legend beside whatever fits.
export function blocksFor(snap: Snapshot | null) {
  if (!snap || snap.segments.length === 0) return []
  const bar = snap.segments.map(s =>
    s.kind === 'used'
      ? { value: s.tokens, color: s.color }
      // The autocompact buffer is drawn like free space: modbar's empty-cell colour.
      : { value: s.tokens, color: undefined, dim: true, empty: true },
  )
  return [
    { id: 'context-bar.usage', owner: 'context-bar', order: 10, width: 'full', lines: [{ pieces: [{ bar }, { text: ` ${snap.percent}% · ${k(snap.total)}/${k(snap.max)}` }] }] },
    {
      id: 'context-bar.legend', owner: 'context-bar', order: 11, width: 'fill',
      lines: [{ pieces: snap.segments.filter(s => s.kind === 'used').flatMap(s => [{ text: '■', color: s.color }, { text: ` ${SHORT[s.name] ?? s.name} ${k(s.tokens)}  `, dim: true }]) }],
    },
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  // /compact runs no turn, and usage stays at the old size until the next response:
  // redraw from compaction's own figure (a precompute changes nothing).
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger === 'precompute' || 'skip' in done) return done
    // Reading now, not at the next draw: a read already running would miss the figure.
    if (done.tokensAfter !== undefined) await refresh($, done.tokensAfter).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    else refreshSoon($)
    return done
  })

  on('modbar.blocks', async ($, e, next) => {
    const below = valueOf(await next(e))
    const snap = await read($, snapshot)
    // State is per session: after /clear (a new session, with no session.start) it is empty.
    if (!snap) refreshSoon($)
    return answer([...below, ...blocksFor(snap)])
  })
}
