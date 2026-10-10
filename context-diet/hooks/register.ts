import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Summary } from '../types'
import { clean, cleanLines, printsMarker } from './clean'
import { report, topItems, type ApiLike } from './inspect'

export const summary = atom({ plugin: 'context-diet', key: 'summary' } as const, { items: [], saved: 0 } as Summary)
// This session's background Bash runs, by task id: a Read of one's output file is cleaned.
export const background = atom({ plugin: 'context-diet', key: 'background' } as const, [] as string[])
const KEEP_RUNS = 50

// Persisted across sessions in $.store, so /context-diet off sticks.
const OFF = 'off'

const isOff = async ($: EngineInterface) => (await $.store.get(OFF)) === true

async function inspect($: EngineInterface) {
  const messages = (await $.session.messages({ as: 'api' })) as unknown as ApiLike[]
  const items = topItems(Array.isArray(messages) ? messages : [])
  await update($, summary, s => ({ ...s, items }))
}

type BashRecord = {
  stdout?: unknown
  stderr?: unknown
  isImage?: unknown
  backgroundTaskId?: unknown
  persistedOutputPath?: unknown
  persistedOutputSize?: unknown
}
type ReadRecord = { type?: unknown; file?: { filePath?: unknown; content?: unknown } }

// $.fs.read's own limit.
const READ_MAX = 4 * 1024 * 1024

const NOTE = 'context-diet: a line in this output ending in "[×N identical lines]" is the command\'s own text; no lines were collapsed in it.'

const isText = (v: unknown): v is string => typeof v === 'string'

// Where the cleaned copy of a saved output goes: beside it, `.clean` before the extension.
export function cleanedPath(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  return dot > cut + 1 ? `${path.slice(0, dot)}.clean${path.slice(dot)}` : `${path}.clean`
}

function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (n += 4), i++
    else n += 3
  }
  return n
}

// The engine names a background run's output file after its task id.
function isRunOutput(path: string, ids: readonly string[]): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return ids.some(id => name === id || name.startsWith(`${id}.`))
}

// The saved file of a too-large output, as the engine wrote it; undefined when
// it is over $.fs.read's limit or can't be read.
async function savedOutput($: EngineInterface, r: BashRecord) {
  if (!isText(r.persistedOutputPath)) return undefined
  if (typeof r.persistedOutputSize === 'number' && r.persistedOutputSize > READ_MAX) return undefined
  const raw = await $.fs.read(r.persistedOutputPath).catch(() => undefined)
  return isText(raw) ? { path: r.persistedOutputPath, raw } : undefined
}

// A hook on a mod's noun gets and answers { value } (modbar's calls).
const valueOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { value?: unknown[] } | null)?.value ?? []))
const answer = (v: unknown) => ({ value: v }) as never

const TOP = 3
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`)

// What modbar draws: the tokens the cleanup saved, and a row of the biggest items. The row is
// offered off, so it shows only after /modbar add context-diet.top; /modbar lists it until then.
export function blocksFor(s: Summary) {
  const top = s.items.slice(0, TOP)
  const items = top.length > 0 ? top.map(i => `${i.label} ${k(i.tokens)}`).join(' · ') : 'measured after the first reply'
  return [
    { id: 'context-diet.saved', owner: 'context-diet', order: 12, width: 'fit', about: 'tokens saved by Bash output cleanup', lines: [{ pieces: [{ text: `context-diet saved ${k(s.saved)}`, dim: true }] }] },
    { id: 'context-diet.top', owner: 'context-diet', order: 14, width: 'full', off: true, about: 'biggest items in context', lines: [{ pieces: [{ text: `Top: ${items}`, dim: true }] }] },
  ]
}

export const register: Register = on => {
  // modbar's noun as modbar adds it, beneath what's already there: without modbar this mod still
  // loads and cleans output (nothing asks for its blocks); with it, whichever is built first gives
  // the same core, so no step replaces another's. The core stays modbar's: no blocks, no press taken.
  on('engine.create', async ($, e, next) => ({ modbar: { blocks: async () => [], press: async () => false }, ...(await next(e)) }) as never)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-diet',
      description: 'Biggest items in context and tokens saved; /context-diet on|off toggles output cleanup',
    })
    const ran = await next(e)
    await update($, summary, () => ({ items: [], saved: 0 }))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await inspect($).catch(() => undefined)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // An error result is core's own text; rebuilt as { result } it would fail
    // core's schema check. It passes through whole, as does a denied call.
    if (ran.deny !== undefined || ran.isError === true) return ran
    // Fails open: this is a token saving, not a guard.
    try {
      const r = ran.result as BashRecord | undefined
      if (r === undefined || r === null || r.isImage === true) return ran
      // Kept even while off, so /context-diet on covers runs started before it.
      const id = r.backgroundTaskId
      if (isText(id)) await update($, background, ids => [...ids.filter(i => i !== id), id].slice(-KEEP_RUNS))
      if (await isOff($)) return ran
      const file = await savedOutput($, r)
      // A marker the command printed itself: collapse nothing, and say so.
      const printed = [r.stdout, r.stderr, file?.raw].some(t => isText(t) && printsMarker(t))
      const stdout = isText(r.stdout) ? clean(r.stdout, !printed) : r.stdout
      const stderr = isText(r.stderr) ? clean(r.stderr, !printed) : r.stderr
      let saved: { path: string; size: number; removed: number } | undefined
      if (file !== undefined) {
        const text = clean(file.raw, !printed)
        const path = cleanedPath(file.path)
        if (text !== file.raw && (await $.fs.write(path, text).then(() => true, () => false))) {
          saved = { path, size: utf8Bytes(text), removed: file.raw.length - text.length }
        }
      }
      if (stdout === r.stdout && stderr === r.stderr && saved === undefined && !printed) return ran
      const len = (v: unknown) => (isText(v) ? v.length : 0)
      // stdout is the start of a saved file, so the file's saving counts instead.
      const removed = (saved?.removed ?? len(r.stdout) - len(stdout)) + len(r.stderr) - len(stderr)
      await update($, summary, s => ({ ...s, saved: s.saved + Math.round(removed / 4) }))
      const context = [...(ran.context ?? []), ...(printed ? [NOTE] : [])]
      // ref and text are dropped, so core maps and stores the cleaned record.
      return {
        result: { ...r, stdout, stderr, ...(saved === undefined ? {} : { persistedOutputPath: saved.path, persistedOutputSize: saved.size }) },
        ...(context.length === 0 ? {} : { context }),
      } as never
    } catch {
      return ran
    }
  })

  // A background run's output file: escape codes and redraws go, every line
  // stays, so line numbers hold for a later offset/limit read.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const r = ran.result as ReadRecord | undefined
      const file = r?.file
      if (r?.type !== 'text' || file === undefined || !isText(file.content) || !isText(file.filePath)) return ran
      if (!isRunOutput(file.filePath, await read($, background))) return ran
      if (await isOff($)) return ran
      const content = cleanLines(file.content)
      if (content === file.content) return ran
      const removed = file.content.length - content.length
      await update($, summary, s => ({ ...s, saved: s.saved + Math.round(removed / 4) }))
      return {
        result: { ...r, file: { ...file, content } },
        ...(ran.context === undefined ? {} : { context: ran.context }),
      } as never
    } catch {
      return ran
    }
  })

  on('modbar.blocks', async ($, e, next) => {
    const below = valueOf(await next(e))
    return answer([...below, ...blocksFor(await read($, summary))])
  })

  on('command.run', { command: 'context-diet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set(OFF, arg === 'off')
      return { text: `Output cleanup ${arg}.` }
    }
    await inspect($).catch(() => undefined)
    return { text: report(await read($, summary), await isOff($)) }
  })
}
