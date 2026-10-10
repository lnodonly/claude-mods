// Lossless cleanup of command output: what a terminal would show once the
// command finished, without the escape codes and redraws that drew it.

const OSC = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?/g
// DCS, SOS, PM and APC strings (sixel and kitty images, terminal queries): a
// terminal never shows the payload. Removed whole only when the string ends
// in the line; otherwise just the introducer goes, so no text can be lost.
const STRING = /\x1b[PX^_][^\x07\x18\x1a\x1b]*(?:\x07|\x1b\\)/g
const STRING_START = /\x1b[PX^_]/
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// nF sequences (charset designation, ESC ( B) and two-byte ones (ESC 7, ESC =).
const OTHER = /\x1b[ -/]+[0-~]|\x1b[0-~]/g
// Cursor-forward moves past cells: kept as spaces so words stay apart.
const FORWARD = /\x1b\[(\d*)C/g
const FORWARD_MAX = 200
// Cursor moves within a line: right (C), left (D), to a column (G), and
// erase-line (K: 0 or none to the end, 1 to the cursor, 2 the whole line).
const MOVE = /\x1b\[(\d*)([CDGK])/g
// A line that needs drawing even without a \r: one that moves left or erases.
const DRAWN = /\x1b\[\d*[DGK]/
const MAX_COLUMN = 10_000
const WHOLE_ERASE = /\x1b\[2K/g
const EDGE_ERASE = /\x1b\[0?K/
// Counting a column per code unit matches the screen only for printable
// ASCII: no tabs, no wide or combining characters.
const ONE_COLUMN = /^[ -~]*$/

export function stripEscapes(s: string): string {
  if (s.indexOf('\x1b') === -1) return s
  return s
    .replace(OSC, '')
    .replace(STRING, '')
    .replace(FORWARD, (_, n: string) => ' '.repeat(Math.min(Number(n || 1), FORWARD_MAX)))
    .replace(CSI, '')
    .replace(OTHER, '')
}

// Draws one line's frames into a row of cells as a terminal does: text writes
// at the cursor, \r returns it to the start, moves and erase-lines act where
// they stand. Undefined when columns can't be counted safely.
function draw(frames: string[]): string | undefined {
  const cells: (string | undefined)[] = []
  let col = 0
  const write = (raw: string) => {
    const text = stripEscapes(raw)
    if (!ONE_COLUMN.test(text)) return false
    for (let i = 0; i < text.length; i++) cells[col++] = text[i]
    return true
  }
  for (const frame of frames) {
    col = 0
    let at = 0
    for (const m of frame.matchAll(MOVE)) {
      if (!write(frame.slice(at, m.index))) return undefined
      at = m.index! + m[0].length
      const n = m[1] === '' ? 0 : Number(m[1])
      if (m[2] === 'C') col += Math.min(Math.max(n, 1), FORWARD_MAX)
      else if (m[2] === 'D') col = Math.max(col - Math.max(n, 1), 0)
      else if (m[2] === 'G') col = Math.max(n, 1) - 1
      else if (n === 0) cells.length = Math.min(cells.length, col)
      else if (n === 1) cells.fill(undefined, 0, Math.min(col + 1, cells.length))
      else if (n === 2) cells.length = 0
      if (col > MAX_COLUMN) return undefined
    }
    if (!write(frame.slice(at))) return undefined
  }
  let end = cells.length
  while (end > 0 && cells[end - 1] === undefined) end--
  let out = ''
  for (let i = 0; i < end; i++) out += cells[i] ?? ' '
  return out
}

// Where columns can't be counted, every frame is kept, separated by \r, but
// for what an erase-line certainly removed: all before the last ESC[2K, and
// the frames before one that starts by erasing (nothing printed or moved first).
function keepFrames(line: string): string {
  let from = 0
  for (const m of line.matchAll(WHOLE_ERASE)) from = m.index! + m[0].length
  const frames = line.slice(from).split('\r')
  let start = 0
  frames.forEach((f, i) => {
    const m = EDGE_ERASE.exec(f)
    if (m === null) return
    const before = f.slice(0, m.index)
    if (stripEscapes(before) === '' && !/\x1b\[\d*G/.test(before)) start = i
  })
  return frames.slice(start).map(stripEscapes).filter(t => t !== '').join('\r')
}

// One line (no \n, no line-ending \r) with bare \r redraws or cursor moves.
export function renderLine(line: string): string {
  const frames = line.split('\r')
  // An image in a control string can move the cursor to another row, so
  // neither overlaying nor an erase-line can be trusted: keep every frame.
  if (STRING_START.test(line)) return frames.map(stripEscapes).filter(t => t !== '').join('\r')
  return draw(frames) ?? keepFrames(line)
}

type Row = { text: string; eol: string }

function rows(text: string): Row[] {
  return text.split('\n').map(raw => {
    // Every \r at the end is the line's ending (\r\n, or \r\r\n from some
    // Windows tools) and is kept byte for byte.
    let end = raw.length
    while (end > 0 && raw.charCodeAt(end - 1) === 13) end--
    const body = raw.slice(0, end)
    const drawn = body.includes('\r') || (body.includes('\x1b') && DRAWN.test(body))
    return { text: drawn ? renderLine(body) : stripEscapes(body), eol: raw.slice(end) }
  })
}

// What the cleanup writes after a collapsed run; a line already ending so is
// the command's own text.
const MARKER = /  \[×\d+ identical lines\]$/

export function printsMarker(text: string): boolean {
  if (!text.includes(' identical lines]')) return false
  return rows(text).some(r => MARKER.test(r.text))
}

// Steps 1 and 2 only, so every line stays where it was (for a Read).
export function cleanLines(text: string): string {
  if (!text.includes('\x1b') && !text.includes('\r')) return text
  const result = rows(text).map(r => r.text + r.eol).join('\n')
  return result === text ? text : result
}

const MIN_RUN = 3

// All three steps. With collapse false, or when the text already prints a
// marker, runs of identical lines stay, so every marker is the cleanup's own.
export function clean(text: string, collapse = true): string {
  const all = rows(text)
  const merge = collapse && !all.some(r => MARKER.test(r.text))
  const out: string[] = []
  for (let i = 0; i < all.length; ) {
    const row = all[i]!
    let j = i + 1
    while (j < all.length && all[j]!.text === row.text && all[j]!.eol === row.eol) j++
    const run = j - i
    const eol = row.eol
    const marked = `${row.text}  [×${run} identical lines]${eol}`
    // Only when it saves: for short lines the marker outweighs the run.
    if (merge && run >= MIN_RUN && marked.length < run * (row.text.length + eol.length + 1) - 1) out.push(marked)
    else for (let n = 0; n < run; n++) out.push(row.text + eol)
    i = j
  }
  const result = out.join('\n')
  return result === text ? text : result
}
