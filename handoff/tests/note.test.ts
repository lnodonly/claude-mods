import { describe, expect, test } from 'claude-code/testing'

import { age, autoNote, fullNote, legacyKey, noteKey, parseNote, relativeTo, stamp } from '../hooks/note'

const CWD = '/Users/u/Repository/my-project'
const AT = new Date(2026, 9, 7, 21, 40).getTime()

describe('note', () => {
  test('key: the folder made safe, then a hash of the whole path', async () => {
    expect(await noteKey(CWD)).toBe('-Users-u-Repository-my-project-0af20ff9')
    expect(legacyKey('/a b/c.d')).toBe('-a-b-c-d')
  })
  // Backlog #79: folders that read alike shared one note; a deep path made a name too long to write.
  test('folders that read alike get their own keys; a deep path still fits a file name', async () => {
    expect(await noteKey('/a-b')).toBe('-a-b-590bb8f6')
    expect(await noteKey('/a/b')).toBe('-a-b-662b7b62')
    expect(await noteKey('/\u00e9')).not.toBe(await noteKey('/\u00fc'))
    expect(await noteKey(`/${'x'.repeat(400)}`)).toMatch(/^x{200}-[0-9a-f]{8}$/)
  })
  test('stamp and the band date', () => {
    expect(stamp(AT)).toBe('2026-10-07 21:40')
  })
  test('a full note: header line, then the body as written', () => {
    expect(fullNote(CWD, AT, '\n## Done\n\nStuff.\n')).toBe('# Handoff · my-project · 2026-10-07 21:40 · full\n\n## Done\n\nStuff.\n')
  })
  // Backlog #82: a reply wrapped in a code fence kept it, in /handoff show and Claude's context.
  test('a full note drops a code fence wrapped round the whole reply', () => {
    const want = '# Handoff · my-project · 2026-10-07 21:40 · full\n\n## Done\n\nStuff.\n'
    expect(fullNote(CWD, AT, '```markdown\n## Done\n\nStuff.\n```\n')).toBe(want)
    expect(fullNote(CWD, AT, '```\n\n## Done\n\nStuff.\n\n```')).toBe(want)
    expect(fullNote(CWD, AT, '~~~md\n## Done\n\nStuff.\n~~~')).toBe(want)
    expect(fullNote(CWD, AT, '```markdown\n## Done\n\n```bash\nnpm test\n```\n```')).toBe('# Handoff · my-project · 2026-10-07 21:40 · full\n\n## Done\n\n```bash\nnpm test\n```\n')
  })
  test('a code block inside the note is kept', () => {
    const body = '## Done\n\nRan:\n\n```bash\nnpm test\n```'
    expect(fullNote(CWD, AT, body)).toBe(`# Handoff · my-project · 2026-10-07 21:40 · full\n\n${body}\n`)
  })
  test('an automatic note', () => {
    expect(autoNote(CWD, AT, { lastRequest: 'Fix the login bug', files: ['config.xml', '/tmp/x.txt'], tasks: ['Verify on staging'] })).toBe([
      '# Handoff · my-project · 2026-10-07 21:40 · auto',
      '',
      '> Automatic note: no summary was written. Run /handoff before leaving for a full one.',
      '',
      '## Last request',
      '',
      '> Fix the login bug',
      '',
      '## Files changed',
      '',
      '- config.xml',
      '- /tmp/x.txt',
      '',
      '## Open tasks',
      '',
      '- Verify on staging',
      '',
      '## Next steps',
      '',
      'None written. Run /handoff for next steps.',
      '',
    ].join('\n'))
  })
  test('an automatic note with nothing in it says None.', () => {
    const n = autoNote(CWD, AT, { files: [], tasks: [] })
    expect(n).toContain('## Last request\n\nNone.')
    expect(n).toContain('## Next steps\n\nNone written. Run /handoff for next steps.')
  })
  test('parse: kind, date and unfinished next steps', () => {
    const text = '# Handoff · x · 2026-10-07 21:40 · auto\n\n## Next steps\n\n- [ ] One\n- [x] Done already\n* [ ] Two\n\n## Gotchas\n\n- [ ] not a step\n'
    expect(parseNote(text)).toEqual({ kind: 'auto', written: '2026-10-07 21:40', steps: ['One', 'Two'], text })
  })
  test('a note without the header still loads; an empty one is no note', () => {
    expect(parseNote('## Next steps\n- [ ] Only step\n')).toEqual({ kind: 'full', written: '', steps: ['Only step'], text: '## Next steps\n- [ ] Only step\n' })
    expect(parseNote('  \n')).toBeUndefined()
  })
  // Backlog #77: an old note is never expired (it matters most after a long break); its age is said.
  test("age: calendar days from the note's date to now, by local time", () => {
    expect(age('2026-10-07 09:00', AT)).toBe('today')
    expect(age('2026-10-06 23:50', new Date(2026, 9, 7, 0, 10).getTime())).toBe('yesterday')
    expect(age('2026-09-03 14:00', AT)).toBe('34 days ago')
    expect(age('2025-10-07 21:40', AT)).toBe('365 days ago')
  })
  test('no age for an undated note or one dated after now', () => {
    expect(age('', AT)).toBeUndefined()
    expect(age('2026-10-08 09:00', AT)).toBeUndefined()
  })
  test('paths relative to the folder when inside it', () => {
    expect(relativeTo(CWD, `${CWD}/config.xml`)).toBe('config.xml')
    expect(relativeTo(CWD, '/tmp/x.txt')).toBe('/tmp/x.txt')
    expect(relativeTo(CWD, `${CWD}-old/a`)).toBe(`${CWD}-old/a`)
  })
})
