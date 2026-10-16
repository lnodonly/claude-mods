import { describe, expect, test } from 'claude-code/testing'

import { edit, ROOT, RULES_JSON, setup } from './fixtures'

const FILES = { [`${ROOT}/.claude/rules.json`]: RULES_JSON }

describe('skill gate', () => {
  test('refuses a gated edit until the skill is loaded', async ($, on) => {
    setup(on, FILES)
    const denied = await $.tool.call(edit(`${ROOT}/config/schema.json`))
    expect(denied.deny).toMatch(/load the `schema-rules` skill/)

    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    const allowed = await $.tool.call(edit(`${ROOT}/config/schema.json`))
    expect(allowed.deny).toBeUndefined()
  })

  test('ungated files and projects without rules are untouched', async ($, on) => {
    setup(on, FILES)
    expect((await $.tool.call(edit(`${ROOT}/README.md`))).deny).toBeUndefined()
    expect((await $.tool.call(edit('/elsewhere/config/schema.json'))).deny).toBeUndefined()
  })

  test('gates Bash commands by regex', async ($, on) => {
    setup(on, FILES)
    expect((await $.tool.call({ tool: 'Bash', command: 'migrate status' })).deny).toMatch(/db-migrations/)
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  })

  test('applies from a subfolder session and to relative paths', async ($, on) => {
    setup(on, FILES, { cwd: `${ROOT}/config` })
    expect((await $.tool.call(edit('schema.json'))).deny).toMatch(/schema-rules/)
    expect((await $.tool.call(edit('../config/./templates/home.html'))).deny).toMatch(/schema-rules/)
  })

  test('compaction forgets loaded skills', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.PostCompact({ trigger: 'auto', compact_summary: '' })
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toMatch(/schema-rules/)
  })

  test('re-reads rules.json when its mtime changes', async ($, on) => {
    const files: Record<string, string> = { ...FILES }
    let mtime = 1
    setup(on, files, { mtime: () => mtime })
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toBeDefined()
    files[`${ROOT}/.claude/rules.json`] = '{"skills":[],"docs":[]}'
    mtime = 2
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toBeUndefined()
  })

  test('a malformed rules.json is ignored, not fatal', async ($, on) => {
    setup(on, { [`${ROOT}/.claude/rules.json`]: '{ nope' })
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toBeUndefined()
  })
})
