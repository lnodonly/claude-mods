import { describe, expect, test } from 'claude-code/testing'

import {
  ancestors, blockedBy, globToRegExp, matchesAny, normalize, owedDocs, parseRules,
  relativeTo, requiredSkill, skillLoaded, type Rules,
} from '../hooks/rules'

const RULES: Rules = {
  skills: [
    { paths: ['config/schema.json', 'config/templates/**'], skill: 'schema-rules' },
    { commands: ['^\\s*migrate\\s'], skill: 'db-migrations' },
  ],
  docs: [
    { paths: ['config/templates/*.html'], docs: ['docs/style-guide.md', 'docs/api-notes.md'] },
    { paths: ['config/style.css'], docs: ['docs/api-notes.md'] },
  ],
  block: [],
}

describe('globs', () => {
  test('* stays within a segment, ** crosses segments', async () => {
    expect(globToRegExp('config/*.html').test('config/a.html')).toBe(true)
    expect(globToRegExp('config/*.html').test('config/x/a.html')).toBe(false)
    expect(globToRegExp('config/**').test('config/x/y/a.html')).toBe(true)
    expect(globToRegExp('**/schema.json').test('schema.json')).toBe(true)
    expect(globToRegExp('**/schema.json').test('a/b/schema.json')).toBe(true)
  })
  test('anchored and dots are literal', async () => {
    expect(globToRegExp('schema.json').test('xschema.json')).toBe(false)
    expect(globToRegExp('schema.json').test('schemaXjson')).toBe(false)
    expect(matchesAny('style.css', ['*.json', '*.css'])).toBe(true)
  })
})

describe('paths', () => {
  test('normalize folds relative and .. against cwd', async () => {
    expect(normalize('../docs/x.md', '/p/config')).toBe('/p/docs/x.md')
    expect(normalize('/p/./a//b/../c', '/ignored')).toBe('/p/a/c')
    expect(normalize('a.txt', '/')).toBe('/a.txt')
  })
  test('ancestors walks to the filesystem root', async () => {
    expect(ancestors('/a/b')).toEqual(['/a/b', '/a', '/'])
    expect(ancestors('/')).toEqual(['/'])
  })
  test('relativeTo only accepts paths inside the root', async () => {
    expect(relativeTo('/p', '/p/config/a.css')).toBe('config/a.css')
    expect(relativeTo('/p', '/pother/a.css')).toBeUndefined()
    expect(relativeTo('/', '/a.css')).toBe('a.css')
  })
})

describe('skills', () => {
  test('requiredSkill matches paths and commands', async () => {
    expect(requiredSkill(RULES, { path: 'config/schema.json' })).toBe('schema-rules')
    expect(requiredSkill(RULES, { path: 'config/templates/x/y.html' })).toBe('schema-rules')
    expect(requiredSkill(RULES, { path: 'docs/style-guide.md' })).toBeUndefined()
    expect(requiredSkill(RULES, { command: 'migrate status --to=staging' })).toBe('db-migrations')
    expect(requiredSkill(RULES, { command: 'echo migrate ' })).toBeUndefined()
  })
  test('namespaced skill names satisfy bare rule names', async () => {
    expect(skillLoaded(['schema-rules'], 'schema-rules')).toBe(true)
    expect(skillLoaded(['pkg:schema-rules'], 'schema-rules')).toBe(true)
    expect(skillLoaded(['not-schema-rules'], 'schema-rules')).toBe(false)
  })
})

describe('owedDocs', () => {
  test('owed when a mapped file changed and none of its docs did', async () => {
    const owed = owedDocs(RULES, ['config/templates/home.html'], [])
    expect(owed).toHaveLength(1)
    expect(owed[0]!.changed).toEqual(['config/templates/home.html'])
  })
  test('any one of the docs satisfies the rule', async () => {
    expect(owedDocs(RULES, ['config/templates/home.html', 'docs/api-notes.md'], [])).toEqual([])
  })
  test('a waived file is not owed', async () => {
    expect(owedDocs(RULES, ['config/style.css'], ['config/style.css'])).toEqual([])
  })
  test('unmapped edits owe nothing', async () => {
    expect(owedDocs(RULES, ['README.md'], [])).toEqual([])
  })
})

describe('parseRules', () => {
  test('accepts a valid file and defaults missing sections', async () => {
    expect(parseRules('{"skills":[{"paths":["a"],"skill":"s"}]}')).toEqual({
      skills: [{ paths: ['a'], skill: 's' }], docs: [], block: [],
    })
  })
  test('rejects bad JSON, bad shapes and bad regexes with a message', async () => {
    expect(() => parseRules('{')).toThrow()
    expect(() => parseRules('{"skills":[{"skill":"s"}]}')).toThrow('needs paths or commands')
    expect(() => parseRules('{"skills":[{"commands":["("],"skill":"s"}]}')).toThrow('invalid regex')
    expect(() => parseRules('{"docs":[{"paths":["a"],"docs":[]}]}')).toThrow('docs')
    expect(() => parseRules('{"block":[{"commands":["x"]}]}')).toThrow('needs a "reason"')
    expect(() => parseRules('{"block":[{"reason":"no"}]}')).toThrow('needs paths or commands')
    expect(() => parseRules('{"block":[{"commands":["("],"reason":"no"}]}')).toThrow('invalid regex')
    expect(() => parseRules('{"block":{}}')).toThrow('"block" must be an array')
  })
  test('block rules: commands match anywhere, also with quotes and backslashes dropped; paths are globs', async () => {
    const r = parseRules(JSON.stringify({ block: [{ commands: ['deploy\\.sh'], reason: 'Use the build pipeline.' }, { paths: ['secrets/**'], reason: 'Hands off.' }] }))
    expect(r.block).toEqual([{ commands: ['deploy\\.sh'], reason: 'Use the build pipeline.' }, { paths: ['secrets/**'], reason: 'Hands off.' }])
    for (const c of ['python3 deploy.sh --exact x', 'cd p && python3 -u deploy.sh', "bash -c 'python3 deploy.sh'", "python3 dep'loy'.sh", 'python3 "deploy.sh"']) {
      expect(blockedBy(r, { command: c })?.match).toBe('deploy\\.sh')
    }
    expect(blockedBy(r, { command: 'python3 report.py' })).toBeUndefined()
    expect(blockedBy(r, { command: 'cat deploy_sh.txt' })).toBeUndefined()
    expect(blockedBy(r, { path: 'secrets/key.txt' })?.rule.reason).toBe('Hands off.')
    expect(blockedBy(r, { path: 'docs/a.md' })).toBeUndefined()
  })
})
