// A handoff note: its file key, its two formats, and what a session reads from it.

export type Note = { kind: 'full' | 'auto'; written: string; steps: string[]; text: string }
export type Previous = { title: string; body: string }
export type Tracked = { lastRequest?: string; lastRequestMissing?: string; files: string[]; tasks: string[]; previous?: Previous }

// A note's file name: the folder's path with every character but letters and digits made `-` (the
// last 200 characters, so a deep path still fits a file name), then a hash of the whole path, so
// folders that read alike (`/a-b` and `/a/b`, or names in another script) each get their own note.
export async function noteKey(cwd: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cwd)))
  const hash = [...digest.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${legacyKey(cwd).slice(-200)}-${hash}`
}

// The key before it had a hash: a note saved under it is still read until the folder has one
// under its own key.
export const legacyKey = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

export const FORK_PROMPT = [
  'Write a handoff note for whoever continues this work in a new session (it may be you, with none of this conversation). Use exactly these sections, in this order:',
  '',
  '## Done',
  '## Where things stand',
  '## Next steps',
  '## Open questions',
  '## Gotchas',
  '',
  'Be specific: file paths, commands, decisions and why. Under "## Next steps", write 1 to 7 items as "- [ ] …", most important first. Write "None." under a section with nothing in it. Stay under 350 words. Reply with the note only.',
].join('\n')

const pad = (n: number) => String(n).padStart(2, '0')
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// How old a note is, in calendar days by local time (the time its stamp is written in): `today`,
// `yesterday` or `N days ago`. None for an undated note or one dated after now. A note is never
// expired, as it matters most after a long break; its age tells Claude how much to trust it.
export function age(written: string, now: number): string | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d) \d\d:\d\d$/.exec(written)
  // A stamp with no zone is read as local time, as it was written.
  if (m === null || new Date(written.replace(' ', 'T')).getTime() > now) return undefined
  const today = new Date(now)
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(+m[1]!, +m[2]! - 1, +m[3]!).getTime()) / 86_400_000)
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd
const header = (cwd: string, ms: number, kind: Note['kind']) => `# Handoff · ${folderName(cwd)} · ${stamp(ms)} · ${kind}`

// The model may write the heading as `### Next Steps:` or `**Next steps**`; the note always says `## Next steps`.
const normalizeSteps = (body: string) => body.replace(/^[ \t]*(?:#{1,6}[ \t]*)?\**[ \t]*Next steps[ \t]*\**:?[ \t]*$/gim, '## Next steps')

// The model may wrap its whole reply in a code fence (```markdown … ```); the note is what's inside.
const unfence = (body: string) => /^(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n\1[ \t]*$/.exec(body)?.[2]?.trim() ?? body

export const fullNote = (cwd: string, ms: number, body: string) => `${header(cwd, ms, 'full')}\n\n${normalizeSteps(unfence(body.trim()))}\n`

const PREVIOUS = '## Previous full note'

// What an automatic note keeps of the note it replaces: a full note's sections (headings
// demoted, its next steps left out since they may be done by now), or the full note an earlier
// automatic note already kept.
export function previousSection(prev: Note | undefined): Previous | undefined {
  if (prev === undefined) return undefined
  const lines = prev.text.split('\n')
  if (prev.kind === 'auto') {
    const at = lines.findIndex(l => l.startsWith(PREVIOUS))
    if (at < 0) return undefined
    return { title: lines[at]!.slice(3), body: lines.slice(at + 1).join('\n').trim() }
  }
  const body: string[] = []
  let skipping = false
  for (const l of lines.slice(/^# Handoff · /.test(lines[0] ?? '') ? 1 : 0)) {
    if (/^##\s/.test(l)) skipping = /^##\s+Next steps\s*$/i.test(l)
    if (!skipping) body.push(/^#{1,3}\s/.test(l) ? `##${l}` : l)
  }
  const text = body.join('\n').trim()
  return text === '' ? undefined : { title: `Previous full note (${prev.written || 'undated'})`, body: text }
}

export function autoNote(cwd: string, ms: number, t: Tracked): string {
  const list = (xs: string[]) => (xs.length > 0 ? xs.map(x => `- ${x}`).join('\n') : 'None.')
  return [
    header(cwd, ms, 'auto'),
    '',
    '> Automatic note: no summary was written. Run /handoff before leaving for a full one.',
    '',
    '## Last request',
    '',
    // Quoted, so nothing pasted in a request can read as a heading of this note.
    t.lastRequest ? t.lastRequest.slice(0, 500).split('\n').map(l => `> ${l}`).join('\n') : t.lastRequestMissing ? `None (${t.lastRequestMissing}).` : 'None.',
    '',
    '## Files changed',
    '',
    list(t.files),
    '',
    '## Open tasks',
    '',
    list(t.tasks),
    '',
    '## Next steps',
    '',
    // Only a model-written note has steps: copied ones went stale unseen.
    'None written. Run /handoff for next steps.',
    '',
    ...(t.previous ? [`## ${t.previous.title}`, '', t.previous.body, ''] : []),
  ].join('\n')
}

const HEAD = /^# Handoff · .* · (\d{4}-\d\d-\d\d \d\d:\d\d) · (full|auto)\s*$/

export function parseNote(text: string): Note | undefined {
  if (text.trim() === '') return undefined
  const lines = text.split('\n')
  const head = HEAD.exec(lines[0] ?? '')
  const start = lines.findIndex(l => /^##\s+Next steps\s*$/i.test(l))
  const steps: string[] = []
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^##\s/.test(l)) break
      const m = /^\s*[-*] \[ \] (.+?)\s*$/.exec(l)
      if (m) steps.push(m[1]!)
    }
  }
  return { kind: (head?.[2] as Note['kind'] | undefined) ?? 'full', written: head?.[1] ?? '', steps, text }
}

export const relativeTo = (cwd: string, path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
