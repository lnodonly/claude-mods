import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blocksFor, cleanedPath } from '../hooks/register'

const E = '\x1b'

const run = (args: string) => ({
  command: 'context-diet',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

// Nothing stands in for modbar: context-diet adds modbar's noun itself, so every test here also
// shows it works with no modbar loaded.

// Stands in beneath the plugin for core's Bash and the session's messages.
function setup(on: On, bash: Record<string, unknown> | { error: string }, messages: unknown[] = [], opts: { storeThrows?: boolean } = {}) {
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
    mock.store(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '/a', content: 'x\nx\nx' } } }) as never)
    const r = await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
    expect((r as { result: { file: { content: string } } }).result.file.content).toBe('x\nx\nx')
  })
})

describe('a marker the command printed itself', () => {
  test('nothing is collapsed and Claude is told the marker is printed text', async ($, on) => {
    const L = 'Waiting for the database to start...'
    setup(on, { stdout: `${E}[32mok${E}[0m\n${L}\n${L}\n${L}\nbuild  [×3 identical lines]`, stderr: '', interrupted: false })
    const r = await $.tool.call({ tool: 'Bash', command: 'cat log' } as never)
    expect(bashOut(r).stdout).toBe(`ok\n${L}\n${L}\n${L}\nbuild  [×3 identical lines]`)
    expect((r as { context?: string[] }).context?.join('\n')).toMatch(/command's own text/)
  })

  test('the note comes even when nothing else changed', async ($, on) => {
    setup(on, { stdout: 'build  [×3 identical lines]', stderr: '', interrupted: false })
    const r = await $.tool.call({ tool: 'Bash', command: 'cat log' } as never)
    expect(bashOut(r).stdout).toBe('build  [×3 identical lines]')
    expect((r as { context?: string[] }).context?.join('\n')).toMatch(/command's own text/)
  })

  test('an ordinary collapse has no note', async ($, on) => {
    const L = 'Waiting for the database to start...'
    setup(on, { stdout: `${L}\n${L}\n${L}`, stderr: '', interrupted: false })
    const r = await $.tool.call({ tool: 'Bash', command: 'make' } as never)
    expect(bashOut(r).stdout).toBe(`${L}  [×3 identical lines]`)
    expect((r as { context?: string[] }).context).toBeUndefined()
  })
})

describe('saved large output', () => {
  const PATH = '/no/such/dir/tool-results/abc123.txt'
  const LINE = `${E}[32mbuilding module café${E}[0m`
  const RAW = `${Array(5).fill(LINE).join('\n')}\ndone\n`
  const CLEANED = 'building module café  [×5 identical lines]\ndone\n'

  function setupSaved(on: On, opts: { size?: number; readFails?: boolean; writeFails?: boolean } = {}) {
    mock.store(on)
    const reads: string[] = []
    const writes: { path: string; text: string }[] = []
    on('fs.read', (_$, e) => {
      reads.push(e.path)
      if (opts.readFails) throw new Error('unreadable')
      return { value: RAW } as never
    })
    on('fs.write', (_$, e) => {
      if (opts.writeFails) throw new Error('disk full')
      writes.push({ path: e.path, text: e.text })
      return { value: undefined } as never
    })
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: `${LINE}\n${LINE}`, stderr: '', interrupted: false, persistedOutputPath: PATH, persistedOutputSize: opts.size ?? RAW.length },
    }) as never)
    return { reads, writes }
  }

  type Saved = { stdout: string; persistedOutputPath: string; persistedOutputSize: number }
  const saved = (r: unknown) => (r as { result: Saved }).result

  test('the saved file is cleaned beside the engine\'s, and the result points at it with its size', async ($, on) => {
    const { writes } = setupSaved(on)
    const r = saved(await $.tool.call({ tool: 'Bash', command: 'make' } as never))
    expect(writes).toEqual([{ path: '/no/such/dir/tool-results/abc123.clean.txt', text: CLEANED }])
    expect(r.persistedOutputPath).toBe('/no/such/dir/tool-results/abc123.clean.txt')
    // é and × are two bytes each in UTF-8.
    expect(r.persistedOutputSize).toBe(CLEANED.length + 2)
    expect(r.stdout).toBe('building module café\nbuilding module café')
    expect((await $.command.run(run(''))).text).toMatch(/saved ~[1-9]\d* tokens/)
  })

  test('over 4 MiB the file is not read; the preview is still cleaned', async ($, on) => {
    const { reads, writes } = setupSaved(on, { size: 5 * 1024 * 1024 })
    const r = saved(await $.tool.call({ tool: 'Bash', command: 'make' } as never))
    expect(reads).toEqual([])
    expect(writes).toEqual([])
    expect(r.persistedOutputPath).toBe(PATH)
    expect(r.persistedOutputSize).toBe(5 * 1024 * 1024)
    expect(r.stdout).toBe('building module café\nbuilding module café')
  })

  test('a file that cannot be read or written keeps the engine\'s path and size', async ($, on) => {
    setupSaved(on, { readFails: true })
    const a = saved(await $.tool.call({ tool: 'Bash', command: 'make' } as never))
    expect([a.persistedOutputPath, a.persistedOutputSize, a.stdout]).toEqual([PATH, RAW.length, 'building module café\nbuilding module café'])
  })

  test('a failed write keeps the engine\'s path and size', async ($, on) => {
    setupSaved(on, { writeFails: true })
    const a = saved(await $.tool.call({ tool: 'Bash', command: 'make' } as never))
    expect([a.persistedOutputPath, a.persistedOutputSize, a.stdout]).toEqual([PATH, RAW.length, 'building module café\nbuilding module café'])
  })

  test('the cleaned name keeps the extension last', () => {
    expect(cleanedPath('/a/b/x.txt')).toBe('/a/b/x.clean.txt')
    expect(cleanedPath('/a/b.d/x')).toBe('/a/b.d/x.clean')
    expect(cleanedPath('C:\\t\\x.out')).toBe('C:\\t\\x.clean.out')
  })
})

describe('background output', () => {
  const ID = 'b4ydc4wdz'
  const RAW = `${E}[33mprogress 1${E}[0m\r${E}[33mprogress 2${E}[0m\r${E}[2K${E}[32mdone${E}[0m\nsame\nsame\nsame\n\n[exited with code 0]\n`

  function setupBg(on: On) {
    mock.store(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: ID } }) as never)
    on('tool.call', { tool: 'Read' }, (_$, e) => ({
      result: { type: 'text', file: { filePath: (e as { file_path: string }).file_path, content: RAW, numLines: 7, startLine: 1, totalLines: 7 } },
    }) as never)
  }

  type ReadOut = { file: { content: string; numLines: number } }
  const readOut = (r: unknown) => (r as { result: ReadOut }).result.file

  test('a Read of a background run\'s output file is cleaned, every line kept', async ($, on) => {
    setupBg(on)
    await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true } as never)
    const f = readOut(await $.tool.call({ tool: 'Read', file_path: `/tmp/s/tasks/${ID}.output` } as never))
    expect(f.content).toBe('done\nsame\nsame\nsame\n\n[exited with code 0]\n')
    expect(f.numLines).toBe(7)
  })

  test('another file, or a run that was not recorded, is untouched', async ($, on) => {
    setupBg(on)
    expect(readOut(await $.tool.call({ tool: 'Read', file_path: `/tmp/s/tasks/${ID}.output` } as never)).content).toBe(RAW)
    await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true } as never)
    expect(readOut(await $.tool.call({ tool: 'Read', file_path: '/proj/build.output' } as never)).content).toBe(RAW)
    expect(readOut(await $.tool.call({ tool: 'Read', file_path: `/proj/${ID}x.output` } as never)).content).toBe(RAW)
  })

  test('/context-diet off leaves it alone', async ($, on) => {
    setupBg(on)
    await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true } as never)
    await $.command.run(run('off'))
    expect(readOut(await $.tool.call({ tool: 'Read', file_path: `/tmp/s/tasks/${ID}.output` } as never)).content).toBe(RAW)
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
    expect((out.text ?? '').split('\n').filter(l => /^\s+\S+k?\s{2}/.test(l))).toEqual(['   24.1k  Read config.xml'])
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

describe('without modbar', () => {
  test('with no modbar loaded it loads and cleans Bash output', async ($, on) => {
    setup(on, { stdout: `${E}[1mbuilt${E}[0m`, stderr: '', interrupted: false })
    expect(bashOut(await $.tool.call({ tool: 'Bash', command: 'make' } as never)).stdout).toBe('built')
  })
})
