import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blocksFor } from '../hooks/register'

const E = '\x1b'

const run = (args: string) => ({
  command: 'context-diet',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

// modbar isn't loaded in a test: its noun, as modbar provides it.
const stubModbar = (on: On) =>
  on('engine.create', async ($, e, next) => ({ ...(await next(e)), modbar: { blocks: async () => [], press: async () => false } }) as never)

// Stands in beneath the plugin for core's Bash and the session's messages.
function setup(on: On, bash: Record<string, unknown> | { error: string }, messages: unknown[] = [], opts: { storeThrows?: boolean } = {}) {
  stubModbar(on)
  if (opts.storeThrows) on('store.get', () => { throw new Error('store unavailable') })
  else mock.store(on)
  on('tool.call', { tool: 'Bash' }, () => {
    if ('error' in bash) return { isError: true, result: bash.error, text: bash.error, ref: 7 } as never
    return { result: bash } as never
  })
  on('session.messages', () => ({ value: messages }) as never)
}

const bashOut = (r: unknown) => (r as { result: { stdout: string; stderr: string } }).result

describe('Bash cleanup', () => {
  test('colors and repeats are removed from stdout and stderr, and the saving is counted', async ($, on) => {
    const L = 'Waiting for the database to start...'
    setup(on, { stdout: `${E}[32mok${E}[0m\n${L}\n${L}\n${L}`, stderr: `${E}[31merr${E}[0m`, interrupted: false })
    const r = bashOut(await $.tool.call({ tool: 'Bash', command: 'make' } as never))
    expect(r.stdout).toBe(`ok\n${L}  [×3 identical lines]`)
    expect(r.stderr).toBe('err')
    // The test's $ has no state noun; the command reads the same summary.
    expect((await $.command.run(run(''))).text).toMatch(/saved ~[1-9]\d* tokens/)
  })

  test('clean output comes back as the same record, extra fields kept', async ($, on) => {
    const rec = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' }
    setup(on, rec)
    const r = await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true } as never)
    expect((r as { result: unknown }).result).toEqual(rec)
  })

  test('an image result is untouched', async ($, on) => {
    const rec = { stdout: `${E}[1mnot really${E}[0m`, stderr: '', interrupted: false, isImage: true }
    setup(on, rec)
    expect((await $.tool.call({ tool: 'Bash', command: 'cat a.png' } as never) as { result: unknown }).result).toEqual(rec)
  })

  test('an error result passes through as core made it', async ($, on) => {
    setup(on, { error: `${E}[31mls: nope${E}[0m` })
    const r = await $.tool.call({ tool: 'Bash', command: 'ls nope' } as never)
    expect(r).toEqual({ isError: true, result: `${E}[31mls: nope${E}[0m`, text: `${E}[31mls: nope${E}[0m`, ref: 7 })
  })

  test('/context-diet off leaves output alone; on resumes', async ($, on) => {
    setup(on, { stdout: `${E}[32mok${E}[0m`, stderr: '', interrupted: false })
    expect((await $.command.run(run('off'))).text).toBe('Output cleanup off.')
    expect(bashOut(await $.tool.call({ tool: 'Bash', command: 'a' } as never)).stdout).toBe(`${E}[32mok${E}[0m`)
    expect((await $.command.run(run('on'))).text).toBe('Output cleanup on.')
    expect(bashOut(await $.tool.call({ tool: 'Bash', command: 'a' } as never)).stdout).toBe('ok')
  })

  test('a failure inside the cleanup returns the original output (fails open)', async ($, on) => {
    setup(on, { stdout: `${E}[32mok${E}[0m`, stderr: '', interrupted: false }, [], { storeThrows: true })
    expect(bashOut(await $.tool.call({ tool: 'Bash', command: 'a' } as never)).stdout).toBe(`${E}[32mok${E}[0m`)
  })

  test('other tools are untouched', async ($, on) => {
    stubModbar(on)
    mock.store(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '/a', content: 'x\nx\nx' } } }) as never)
    const r = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect((r as { result: { file: { content: string } } }).result.file.content).toBe('x\nx\nx')
  })
})

describe('/context-diet', () => {
  test('lists the biggest items in context', async ($, on) => {
    setup(on, { stdout: '', stderr: '', interrupted: false }, [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/proj/config.xml' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(96_400) }] },
    ])
    const out = await $.command.run(run(''))
    expect(out.text).toContain('24.1k  Read config.xml')
    expect(out.text).toContain('(on)')
    expect(out.text.split('\n').filter(l => /^\s+\S+k?\s{2}/.test(l))).toEqual(['   24.1k  Read config.xml'])
  })
})

// A test can't call $.modbar, so the block is checked through blocksFor,
// which the modbar.blocks hook wraps.
describe('modbar block', () => {
  test('tokens saved, shown; the top three items, offered off', () => {
    const items = [{ label: 'Read a.ts', tokens: 12_345 }, { label: 'Bash make', tokens: 3_000 }, { label: 'Grep x', tokens: 900 }, { label: 'Read b', tokens: 100 }]
    expect(blocksFor({ items, saved: 1_500 })).toEqual([
      { id: 'context-diet.saved', owner: 'context-diet', order: 12, width: 'fit', about: 'tokens saved by Bash output cleanup', lines: [{ pieces: [{ text: 'context-diet saved 1.5k', dim: true }] }] },
      { id: 'context-diet.top', owner: 'context-diet', order: 14, width: 'full', off: true, about: 'biggest items in context', lines: [{ pieces: [{ text: 'Top: Read a.ts 12.3k · Bash make 3.0k · Grep x 900', dim: true }] }] },
    ])
  })

  test('before the first reply both are still offered, so /modbar can list them', () => {
    expect(blocksFor({ items: [], saved: 0 }).map(b => (b.lines[0]!.pieces[0] as { text: string }).text)).toEqual(['context-diet saved 0', 'Top: measured after the first reply'])
  })
})
