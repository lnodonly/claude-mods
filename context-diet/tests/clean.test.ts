import { describe, expect, test } from 'claude-code/testing'

import { clean, renderLine, stripEscapes } from '../hooks/clean'

const E = '\x1b'

// pytest -v with color: green PASSED, bold summary line.
const PYTEST = [
  `tests/test_a.py::test_one ${E}[32mPASSED${E}[0m${E}[32m                       [ 50%]${E}[0m`,
  `tests/test_a.py::test_two ${E}[32mPASSED${E}[0m${E}[32m                       [100%]${E}[0m`,
  `${E}[32m${E}[1m============ 2 passed in 0.03s ============${E}[0m`,
].join('\n')

// curl's progress meter: one line redrawn with bare \r, then a final newline.
const CURL = '  % Total    % Received\n' +
  '\r  0  1256    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0' +
  '\r 48  1256   48   612    0     0   3021      0 --:--:-- --:--:-- --:--:--  3015' +
  '\r100  1256  100  1256    0     0   6190      0 --:--:-- --:--:-- --:--:--  6187\n'

// composer install: erase-line progress plus many identical lines.
const COMPOSER = [
  `${E}[32mInstalling dependencies from lock file${E}[39m`,
  `  - Downloading ${E}[32mpsr/log${E}[39m (${E}[33m3.0.0${E}[39m)`,
  ` 0/3 [>---------------------------]   0%\r${E}[2K 3/3 [============================] 100%`,
  ...Array(5).fill('  - Installing package files'),
  'Generating autoload files',
].join('\n')

// docker compose up: colored service prefixes and identical health-check lines.
const DOCKER = [
  ...Array(4).fill(`${E}[36mdb-1   |${E}[0m waiting for connections`),
  `${E}[33mweb-1  |${E}[0m listening on :8080`,
].join('\n')

describe('stripEscapes', () => {
  test('removes colors, keeps the text', () => {
    expect(stripEscapes(`${E}[1;31mFAIL${E}[0m done`)).toBe('FAIL done')
  })
  test('keeps the visible text of an OSC 8 hyperlink and drops titles', () => {
    expect(stripEscapes(`${E}]8;;https://x.test${E}\\link${E}]8;;${E}\\ and ${E}]0;title\x07end`)).toBe('link and end')
  })
  test('cursor-forward becomes spaces, so words stay apart', () => {
    expect(stripEscapes(`Name${E}[10CValue`)).toBe(`Name${' '.repeat(10)}Value`)
    expect(stripEscapes(`a${E}[Cb`)).toBe('a b')
  })
  test('removes charset and keypad sequences', () => {
    expect(stripEscapes(`${E}(Ba${E}=b${E}7c`)).toBe('abc')
  })
})

describe('renderLine', () => {
  test('a later frame overwrites from the start and a longer tail stays', () => {
    expect(renderLine('Downloading 100%\rDone')).toBe('Doneloading 100%')
  })
  test('an erase-line code clears the earlier frame', () => {
    expect(renderLine(`Downloading 100%\r${E}[2KDone`)).toBe('Done')
    expect(renderLine(`Downloading 100%\r${E}[KDone`)).toBe('Done')
  })
  test('frames with tabs or non-ASCII text are kept, never overlaid by code unit', () => {
    expect(renderLine('\tfoo\rbar1234')).toBe('\tfoo\rbar1234')
    expect(renderLine('日本語テスト\rabc')).toBe('日本語テスト\rabc')
    expect(renderLine('😀😀\ra')).toBe('😀😀\ra')
    expect(renderLine('café\rabcd')).toBe('café\rabcd')
  })
  test('non-ASCII frames before an erase-line are dropped, as the terminal clears them', () => {
    expect(renderLine(`日本語 10%\r${E}[2K日本語 100%`)).toBe('日本語 100%')
    expect(renderLine(`x\r${E}[2K日本\r語`)).toBe('日本\r語')
  })
  test('an empty trailing frame keeps what was drawn', () => {
    expect(renderLine('50%\r100%\r')).toBe('100%')
  })
})

describe('clean', () => {
  test('pytest: colors removed, every line kept', () => {
    expect(clean(PYTEST)).toBe([
      'tests/test_a.py::test_one PASSED                       [ 50%]',
      'tests/test_a.py::test_two PASSED                       [100%]',
      '============ 2 passed in 0.03s ============',
    ].join('\n'))
  })
  test('curl: the progress line shows only its final frame', () => {
    expect(clean(CURL)).toBe('  % Total    % Received\n' +
      '100  1256  100  1256    0     0   6190      0 --:--:-- --:--:-- --:--:--  6187\n')
  })
  test('composer: erase-line progress and an identical run', () => {
    expect(clean(COMPOSER)).toBe([
      'Installing dependencies from lock file',
      '  - Downloading psr/log (3.0.0)',
      ' 3/3 [============================] 100%',
      '  - Installing package files  [×5 identical lines]',
      'Generating autoload files',
    ].join('\n'))
  })
  test('docker: identical lines after colors are removed collapse', () => {
    expect(clean(DOCKER)).toBe('db-1   | waiting for connections  [×4 identical lines]\nweb-1  | listening on :8080')
  })
  test('a run of 2 stays, a run of 3 collapses', () => {
    const L = 'warning: deprecated option --legacy'
    expect(clean(`${L}\n${L}\nb`)).toBe(`${L}\n${L}\nb`)
    expect(clean(`${L}\n${L}\n${L}\nb`)).toBe(`${L}  [×3 identical lines]\nb`)
  })
  test('a run is kept when the marker would make the output longer', () => {
    expect(clean('x\nx\nx\ny')).toBe('x\nx\nx\ny')
    expect(clean('\n\n\n\nend')).toBe('\n\n\n\nend')
  })
  test('nearly identical lines are never merged', () => {
    const t = '12:00:01 tick\n12:00:02 tick\n12:00:03 tick'
    expect(clean(t)).toBe(t)
  })
  test('\\r\\n line endings pass through byte for byte', () => {
    const t = 'one\r\ntwo\r\nthree\r\n'
    expect(clean(t)).toBe(t)
  })
  test('identical \\r\\n lines collapse and keep their ending', () => {
    const L = 'retrying connection to db:5432'
    expect(clean(`${L}\r\n${L}\r\n${L}\r\ny\r\n`)).toBe(`${L}  [×3 identical lines]\r\ny\r\n`)
  })
  test('clean text comes back as the same string', () => {
    const t = 'plain output\nwith two lines'
    expect(clean(t)).toBe(t)
  })
  test('unicode, tabs and NUL bytes survive', () => {
    const t = 'naïve café ✓ 🎉\tcol2\x00end'
    expect(clean(t)).toBe(t)
  })
  test('200,000 lines finish quickly', () => {
    const t = Array.from({ length: 200_000 }, (_, i) => `${E}[32mline ${i % 7}${E}[0m`).join('\n')
    const start = Date.now()
    const out = clean(t)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(out.startsWith('line 0\nline 1\n')).toBe(true)
  })
})
