import { describe, expect, test } from 'claude-code/testing'

import { autoNote, fullNote, noteKey, parseNote, relativeTo, stamp } from '../hooks/note'

const CWD = '/Users/u/Repository/my-project'
const AT = new Date(2026, 9, 7, 21, 40).getTime()

describe('note', () => {
  test('key from the folder', () => {
    expect(noteKey(CWD)).toBe('-Users-u-Repository-my-project')
    expect(noteKey('/a b/c.d')).toBe('-a-b-c-d')
  })
  test('stamp and the band date', () => {
    expect(stamp(AT)).toBe('2026-10-07 21:40')
  })
  test('a full note: header line, then the body as written', () => {
    expect(fullNote(CWD, AT, '\n## Done\n\nStuff.\n')).toBe('# Handoff · my-project · 2026-10-07 21:40 · full\n\n## Done\n\nStuff.\n')
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
  test('paths relative to the folder when inside it', () => {
    expect(relativeTo(CWD, `${CWD}/config.xml`)).toBe('config.xml')
    expect(relativeTo(CWD, '/tmp/x.txt')).toBe('/tmp/x.txt')
    expect(relativeTo(CWD, `${CWD}-old/a`)).toBe(`${CWD}-old/a`)
  })
})
