import { describe, expect, test } from 'claude-code/testing'

import { parseRules } from '../hooks/rules'
import { edit, ROOT, RULES_JSON, setup } from './fixtures'

// Findings from the final branch review, each pinned by a test.
const FILES = { [`${ROOT}/.claude/rules.json`]: RULES_JSON }
const TEMPLATE = `${ROOT}/config/templates/home.html`

describe('review fixes', () => {
  test('Stop blocks at most three times a turn, then lets Claude stop with a visible record', async ($, on) => {
    const ui = setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(edit(TEMPLATE))

    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeDefined()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeDefined()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeDefined()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
    expect(ui.status).toBe('rules: docs owed (unresolved)')
    expect(ui.toasts.some(t => /unresolved/.test(t))).toBe(true)
  })

  // Backlog #27: the cap counts reminders in a row. Claude woken later in the turn (a task
  // notification) and stopping again gets one more reminder before it is let go again.
  test('after the cap, a Stop that follows a wake-up gets one more reminder', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(edit(TEMPLATE))
    for (const active of [false, true, true]) expect((await $.classic.Stop({ stop_hook_active: active })).block).toBeDefined()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()

    await $.classic.UserPromptSubmit({ prompt: '<task-notification>', source: 'system' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeDefined()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  })

  test('rule paths are normalized: ./ is stripped and .. is rejected', async () => {
    const r = parseRules('{"docs":[{"paths":["./config/*.html"],"docs":["./docs/x.md"]}]}')
    expect(r.docs[0]).toEqual({ paths: ['config/*.html'], docs: ['docs/x.md'] })
    expect(() => parseRules('{"docs":[{"paths":["a"],"docs":["../x.md"]}]}')).toThrow('..')
    expect(() => parseRules('{"skills":[{"paths":["/abs/x"],"skill":"s"}]}')).toThrow('relative')
  })

  test('a skill typed as /name counts as loaded', async ($, on) => {
    setup(on, FILES)
    await $.skill.prompt({ skill: 'schema-rules', text: '' })
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toBeUndefined()
  })

  test('/clear forgets loaded skills', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.SessionEnd({ reason: 'clear' })
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toMatch(/schema-rules/)
  })

  test('a skill loaded by the main thread does not cover a subagent, and vice versa', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    expect((await $.tool.call({ ...edit(`${ROOT}/config/schema.json`), agentId: 'a1' } as never)).deny).toMatch(/schema-rules/)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules', agentId: 'a1' } as never)
    expect((await $.tool.call({ ...edit(`${ROOT}/config/schema.json`), agentId: 'a1' } as never)).deny).toBeUndefined()
  })

  test('a system-sourced prompt (task notification) does not wipe the turn ledger', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go', source: 'user' })
    await $.tool.call(edit(TEMPLATE))
    await $.classic.UserPromptSubmit({ prompt: '<task-notification>', source: 'system' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeDefined()
  })

  test('a rules file that vanishes mid-check never blocks an unrelated edit', async ($, on) => {
    setup(on, FILES, { statThrows: true })
    expect((await $.tool.call(edit(`${ROOT}/README.md`))).deny).toBeUndefined()
  })
})
