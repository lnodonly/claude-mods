import type { Item, Summary } from '../types'

export type ApiLike = { role: string; content: { type: string; [f: string]: unknown }[] }

export const IMAGE_TOKENS = 1600
const LABEL_MAX = 60

const cut = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s)
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`)

export function label(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (name) {
    case 'Read': {
      const file = str('file_path')
      if (file === '') return 'Read'
      const off = typeof input.offset === 'number' ? input.offset : undefined
      const lim = typeof input.limit === 'number' ? input.limit : undefined
      const from = off ?? 1
      const range = lim !== undefined ? ` (lines ${from}–${from + lim - 1})` : off !== undefined ? ` (from line ${off})` : ''
      return cut(`Read ${base(file)}${range}`)
    }
    case 'Bash':
      return cut(`Bash ${str('command').split('\n')[0]}`.trim())
    case 'Grep':
    case 'Glob':
      return cut(`${name} ${str('pattern')}`.trim())
    case 'Agent':
      return cut(`Agent ${str('description')}`.trim())
    default:
      return cut(name)
  }
}

export function measure(content: unknown): { tokens: number; image: boolean } {
  if (typeof content === 'string') return { tokens: Math.ceil(content.length / 4), image: false }
  if (!Array.isArray(content)) return { tokens: 0, image: false }
  let chars = 0
  let images = 0
  for (const b of content as { type?: unknown; text?: unknown }[]) {
    if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length
    else if (b.type === 'image') images++
  }
  return { tokens: Math.ceil(chars / 4) + images * IMAGE_TOKENS, image: images > 0 }
}

export function topItems(messages: ApiLike[], n = 10): Item[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>()
  const items: Item[] = []
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        uses.set(b.id, { name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> })
      } else if (b.type === 'tool_result') {
        const u = uses.get(String(b.tool_use_id))
        const { tokens, image } = measure(b.content)
        const name = u ? label(u.name, u.input) : 'Tool result'
        items.push({ label: image ? cut(`${name} (image)`) : name, tokens })
      }
    }
  }
  return items.sort((a, b) => b.tokens - a.tokens).slice(0, n)
}

export function report(s: Summary, off: boolean): string {
  const head = s.items.length === 0
    ? 'No tool results in context yet.'
    : ['Biggest items in context (estimated tokens):', ...s.items.map(i => `${k(i.tokens).padStart(8)}  ${i.label}`)].join('\n')
  return `${head}\nOutput cleanup saved ~${k(s.saved)} tokens this session (${off ? 'off' : 'on'}).`
}
