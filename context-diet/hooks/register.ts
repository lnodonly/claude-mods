import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Summary } from '../types'
import { clean } from './clean'
import { report, topItems, type ApiLike } from './inspect'

export const summary = atom({ plugin: 'context-diet', key: 'summary' } as const, { items: [], saved: 0 } as Summary)

// Persisted across sessions in $.store, so /context-diet off sticks.
const OFF = 'off'

const isOff = async ($: EngineInterface) => (await $.store.get(OFF)) === true

async function inspect($: EngineInterface) {
  const messages = (await $.session.messages({ as: 'api' })) as unknown as ApiLike[]
  const items = topItems(Array.isArray(messages) ? messages : [])
  await update($, summary, s => ({ ...s, items }))
}

type BashRecord = { stdout?: unknown; stderr?: unknown; isImage?: unknown }

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
      if (await isOff($)) return ran
      const r = ran.result as BashRecord | undefined
      if (r === undefined || r === null || r.isImage === true) return ran
      const stdout = typeof r.stdout === 'string' ? clean(r.stdout) : r.stdout
      const stderr = typeof r.stderr === 'string' ? clean(r.stderr) : r.stderr
      if (stdout === r.stdout && stderr === r.stderr) return ran
      const len = (v: unknown) => (typeof v === 'string' ? v.length : 0)
      const removed = len(r.stdout) + len(r.stderr) - len(stdout) - len(stderr)
      await update($, summary, s => ({ ...s, saved: s.saved + Math.round(removed / 4) }))
      // ref and text are dropped, so core maps and stores the cleaned record.
      return {
        result: { ...r, stdout, stderr },
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
