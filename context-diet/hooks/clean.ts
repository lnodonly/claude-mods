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
const ERASE = /\x1b\[[02]?K/
// Overlaying frames by string index matches the screen only when one code
// unit is one column: printable ASCII, no tabs.
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

// One line (no \n, no line-ending \r) with bare \r redraws. Frames before the last
// erase-line are gone from the screen. The rest overwrite from the start,
// keeping a longer earlier tail; where columns can't be counted safely, the
// frames are kept, separated by \r, rather than guessed at.
export function renderLine(line: string): string {
  const frames = line.split('\r')
  // An image in a control string can move the cursor to another row, so
  // neither overlaying nor an erase-line can be trusted: keep every frame.
  if (STRING_START.test(line)) return frames.map(stripEscapes).filter(t => t !== '').join('\r')
  let start = 0
  frames.forEach((f, i) => {
    if (ERASE.test(f)) start = i
  })
  const texts = frames.slice(start).map(stripEscapes)
  if (!texts.every(t => ONE_COLUMN.test(t))) return texts.filter(t => t !== '').join('\r')
  let buf = ''
  for (const text of texts) buf = text + buf.slice(text.length)
  return buf
}

const MIN_RUN = 3

export function clean(text: string): string {
  const lines = text.split('\n')
  const rows = lines.map(raw => {
    // Every \r at the end is the line's ending (\r\n, or \r\r\n from some
    // Windows tools) and is kept byte for byte.
    let end = raw.length
    while (end > 0 && raw.charCodeAt(end - 1) === 13) end--
    const body = raw.slice(0, end)
    return { text: body.includes('\r') ? renderLine(body) : stripEscapes(body), eol: raw.slice(end) }
  })
  const out: string[] = []
  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!
    let j = i + 1
    while (j < rows.length && rows[j]!.text === row.text && rows[j]!.eol === row.eol) j++
    const run = j - i
    const eol = row.eol
    const marked = `${row.text}  [×${run} identical lines]${eol}`
    // Only when it saves: for short lines the marker outweighs the run.
    if (run >= MIN_RUN && marked.length < run * (row.text.length + eol.length + 1) - 1) out.push(marked)
    else for (let n = 0; n < run; n++) out.push(row.text + eol)
    i = j
  }
  const result = out.join('\n')
  return result === text ? text : result
}
