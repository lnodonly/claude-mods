import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModbarBlock, ModbarConfig, ModbarLine, ModbarPiece, ModbarWidth } from '../types'
import { arrange, barCells, EMPTY_CONFIG, editConfig, FILL_GAP, isHidden, pack, parseConfig, pieceWidth, type Change } from './layout'

export const config = atom({ plugin: 'modbar', key: 'config' } as const, EMPTY_CONFIG as ModbarConfig)
export const problem = atom({ plugin: 'modbar', key: 'problem' } as const, null as string | null)

const SHOWN = '~/.claude/modbar.json'
const USAGE = 'Usage: /modbar [list | reload | reset confirm | add|show <id or mod> | remove|hide <id or mod> | width <id> full|half|third|fit|fill | align <id> left|right | order <id> <n>]'
const WIDTHS = ['full', 'half', 'third', 'fit', 'fill']
export const theme = atom({ plugin: 'modbar', key: 'theme' } as const, null as string | null)

// An empty bar cell: darker than the theme's own greys on a dark theme, lighter on a light one.
// An unknown theme (unset, auto) is taken as dark.
export const emptyCell = (t: string | null) => (t?.includes('light') ? '#e4e4e4' : '#262626')

async function readTheme($: EngineInterface) {
  const row = (await $.config.list()).find(r => r.key === 'theme')
  await update($, theme, () => (typeof row?.value === 'string' ? row.value : null))
}

const file = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? ''}/.claude/modbar.json`

async function load($: EngineInterface): Promise<string | null> {
  const path = await file($)
  const text = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
  const r = parseConfig(text)
  await update($, config, () => r.config)
  const msg = r.problem ? `modbar: ${SHOWN}: ${r.problem}; using the defaults.` : null
  await update($, problem, () => msg)
  return msg
}

async function save($: EngineInterface, c: ModbarConfig) {
  await $.fs.write(await file($), `${JSON.stringify(c, null, 2)}\n`)
  await update($, config, () => c)
}

// What the dependents answered, keeping only well-formed blocks: one bad block is dropped, not the band.
const isPiece = (p: unknown): p is ModbarPiece => {
  const x = p as Record<string, unknown> | null
  if (x === null || typeof x !== 'object') return false
  if ('text' in x) return typeof x.text === 'string'
  if ('button' in x) {
    const b = x.button as Record<string, unknown> | null
    return b !== null && typeof b === 'object' && typeof b.key === 'string' && typeof b.label === 'string'
  }
  if ('bar' in x) return Array.isArray(x.bar) && x.bar.every(s => s !== null && typeof s === 'object' && typeof (s as { value?: unknown }).value === 'number')
  return false
}
const isBlock = (b: unknown): b is ModbarBlock => {
  const x = b as ModbarBlock | null
  return x !== null && typeof x === 'object' && typeof x.id === 'string' && typeof x.owner === 'string' && typeof x.order === 'number'
    && WIDTHS.includes(x.width) && Array.isArray(x.lines)
    && (x.off === undefined || typeof x.off === 'boolean') && (x.about === undefined || typeof x.about === 'string')
    && x.lines.every(l => l !== null && typeof l === 'object' && Array.isArray(l.pieces) && l.pieces.every(isPiece))
}

const BROKEN = `modbar: ${SHOWN} has a problem, so nothing was changed. Fix it and run /modbar reload, or /modbar reset confirm.`

async function offered($: EngineInterface, columns: number): Promise<ModbarBlock[]> {
  const r = (await $.modbar.blocks({ columns })) as unknown
  const list = Array.isArray(r) ? r : ((r as { value?: unknown[] } | null)?.value ?? [])
  return list.filter(isBlock)
}

type TextPiece = Extract<ModbarPiece, { text: string }>
// Groups consecutive text pieces; buttons and bars stand alone.
function runs(pieces: ModbarPiece[]): (TextPiece[] | Exclude<ModbarPiece, TextPiece>)[] {
  const out: (TextPiece[] | Exclude<ModbarPiece, TextPiece>)[] = []
  for (const p of pieces) {
    if ('text' in p) {
      const last = out[out.length - 1]
      if (Array.isArray(last)) last.push(p)
      else out.push([p])
    } else out.push(p)
  }
  return out
}

export const register: Register = on => {
  // The noun: alone it offers nothing and handles no press; dependents' hooks add theirs.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, modbar: { blocks: async () => [] as ModbarBlock[], press: async () => false } }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'modbar', description: 'Arrange the area above the prompt: /modbar lists blocks shown and ones you can add; add|remove|width|align|order <id> …' })
    const msg = await load($).catch(() => null)
    if (msg) $.ui.toast(msg)
    await readTheme($).catch(() => {})
    // Blocks can depend on the time (a countdown): redraw once a minute.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.props.hasSurvey) return beneath
    const C = e.props.bodyColumns
    const blocks = arrange(await offered($, C).catch(() => []), await read($, config))
    const EMPTY_CELL = emptyCell(await read($, theme))
    if (blocks.length === 0) return beneath
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = (b: ModbarBlock, l: ModbarLine, width: number, i: number) => {
      const align = l.align ?? b.align ?? 'left'
      const fixed = l.pieces.reduce((a, p) => a + pieceWidth(p), 0)
      return (
        <Box key={`${b.id}:${i}`} width={width} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
          {runs(l.pieces).map((run, j) => {
            // Consecutive text pieces share one Text, so a long line is cut once at its end.
            if (Array.isArray(run)) {
              return (
                <Text key={`t${j}`} wrap="truncate-end">
                  {run.map((p, k) => <Text key={`p${k}`} color={p.color} bold={p.bold} dimColor={p.dim}>{p.text}</Text>)}
                </Text>
              )
            }
            if ('button' in run) {
              return (
                <Box key={`${b.owner}:${run.button.key}`} flexShrink={0}>
                  <Button key={`${b.owner}:${run.button.key}`} label={run.button.label} variant={run.button.primary ? 'primary' : undefined} onPress={() => {}} />
                </Box>
              )
            }
            const cells = barCells(run.bar, Math.max(0, width - fixed))
            // Empty cells are full blocks too, so the bar keeps one height: in the segment's colour
            // dimmed, or the theme's empty-cell colour when it has none (emptyCell).
            return (
              <Text key={`b${j}`}>
                {run.bar.map((s, k) => <Text key={`s${k}`} color={s.color ?? (s.empty ? EMPTY_CELL : undefined)} dimColor={s.empty && !s.color ? false : s.dim}>{'█'.repeat(cells[k] ?? 0)}</Text>)}
              </Text>
            )
          })}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {/* The engine's [-] sits at the right of the first row: keep it to itself. */}
        <Text> </Text>
        {pack(blocks, C).map((row, r) => (
          <Box key={`row${r}`} columnGap={row.some(c => c.block.width === 'fill') ? FILL_GAP : 0}>
            {row.map(c => (
              <Box key={c.block.id} flexDirection="column" width={c.width} flexGrow={c.block.width === 'fill' ? 1 : 0}>
                {c.block.lines.map((l, i) => line(c.block, l, c.width, i))}
              </Box>
            ))}
          </Box>
        ))}
        {beneath}
      </Box>
    )
  })

  // A press on a block's button goes to its owner; the key after the first ':' is theirs.
  // Taken, not passed on: the owner's press can redraw the band without the button, and the
  // button's own (empty) handler is gone with that drawing.
  on('ui.press', { plugin: 'modbar' }, async ($, e, next) => {
    const at = e.element.indexOf(':')
    if (at <= 0) return next(e)
    await $.modbar.press({ owner: e.element.slice(0, at), key: e.element.slice(at + 1) })
    return { element: e.element }
  })

  // A theme change in /config recolours the empty bar cells.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    await readTheme($).catch(() => {})
    return r
  })

  on('command.run', { command: 'modbar' }, async ($, e) => {
    const [said = '', id = '', value = ''] = e.args.trim().split(/\s+/)
    // Other words people reach for: list, add and remove.
    const verb = ({ list: '', add: 'show', remove: 'hide' } as Record<string, string>)[said] ?? said
    const c = await read($, config)
    const apply = async (change: Change, said: string) => {
      await save($, editConfig(c, change))
      return { text: `${id}: ${said}.` }
    }
    if (verb === '') {
      const blocks = await offered($, 100).catch(() => [])
      // Every block in its place, hidden or not; then split into what's drawn and what can be added.
      const all = arrange(blocks, { ...c, blocks: Object.fromEntries(blocks.map(b => [b.id, { ...c.blocks[b.id], hidden: false }])) })
      const kept = new Map(blocks.map(b => [b.id, b]))
      const shown = all.filter(b => !isHidden(kept.get(b.id)!, c))
        .map(b => `  ${b.id} · ${b.owner} · ${b.width} · ${b.align ?? 'left'} · ${b.order}`)
      const addable = all.filter(b => isHidden(kept.get(b.id)!, c))
        .map(b => `  ${b.id} · ${b.owner}${b.about ? ` · ${b.about}` : ''} · ${c.blocks[b.id]?.hidden ? 'hidden' : 'off by default'}`)
      const absent = Object.entries(c.blocks).filter(([k]) => !kept.has(k)).map(([k, v]) => `  ${k} · ${v.hidden ? 'hidden' : 'configured'}`)
      const group = (title: string, ls: string[]) => (ls.length ? [title, ...ls] : [])
      const lines = [...group('Shown:', shown), ...group('Can be added (/modbar add <id>):', addable), ...group('Not offered now:', absent)]
      const p = await read($, problem)
      return { text: [...(p ? [p] : []), ...(lines.length ? lines : ['No blocks right now.'])].join('\n') }
    }
    if (verb === 'reload') return { text: (await load($)) ?? `Reloaded ${SHOWN}.` }
    if (verb === 'reset') {
      if (id !== 'confirm') return { text: 'Type /modbar reset confirm to clear all modbar settings.' }
      await save($, EMPTY_CONFIG)
      await update($, problem, () => null)
      return { text: 'Cleared the modbar settings.' }
    }
    if (id === '') return { text: USAGE }
    // A file with a problem is never overwritten by an edit.
    if ((await read($, problem)) !== null) return { text: BROKEN }
    // A mod's name (no '.') stands for all its blocks: those it offers now and those already configured.
    if ((verb === 'hide' || verb === 'show') && !id.includes('.')) {
      const now = (await offered($, 100).catch(() => [])).filter(b => b.owner === id).map(b => b.id)
      const ids = [...new Set([...now, ...Object.keys(c.blocks).filter(k => k.startsWith(`${id}.`))])]
      if (ids.length === 0) return { text: `No blocks from ${id}. /modbar lists them.` }
      await save($, ids.reduce((acc, b) => editConfig(acc, { id: b, hidden: verb === 'hide' }), c))
      return { text: `${id}: ${verb === 'hide' ? 'hidden' : 'shown'} (${ids.join(', ')}).` }
    }
    if (verb === 'hide') return apply({ id, hidden: true }, 'hidden')
    if (verb === 'show') return apply({ id, hidden: false }, 'shown')
    if (verb === 'width' && WIDTHS.includes(value)) return apply({ id, width: value as ModbarWidth }, `width ${value}`)
    if (verb === 'align' && (value === 'left' || value === 'right')) return apply({ id, align: value }, `align ${value}`)
    if (verb === 'order' && /^\d+$/.test(value) && Number(value) >= 1) return apply({ id, position: Number(value) }, `position ${value}`)
    return { text: USAGE }
  })
}
