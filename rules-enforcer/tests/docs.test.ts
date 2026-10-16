import { describe, expect, test } from 'claude-code/testing'

import { edit, ROOT, RULES_JSON, setup } from './fixtures'

const FILES = { [`${ROOT}/.claude/rules.json`]: RULES_JSON }
const TEMPLATE = `${ROOT}/config/templates/home.html`
const WAIVE = 'mcp__rules-enforcer__waive_doc_update'

describe('doc sync', () => {
  test('blocks Stop while a mapped doc is owed, then allows it once the doc is edited', async ($, on) => {
    const ui = setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(edit(TEMPLATE))
    expect(ui.status).toBe('rules: docs owed')

    const blocked = await $.classic.Stop({ stop_hook_active: false })
    expect(blocked.block).toMatch(/config\/templates\/home\.html/)
    expect(blocked.block).toMatch(/docs\/style-guide\.md/)
    expect(blocked.block).toMatch(/waive_doc_update/)

    await $.tool.call(edit(`${ROOT}/docs/style-guide.md`))
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  })

  // A `git checkout --` revert still owed the docs, and Claude logged a waiver for no change (backlog #135).
  test('a file edited, then put back to its committed version, owes nothing', async ($, on) => {
    const ui = setup(on, FILES, { git: { clean: [TEMPLATE] } })
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(edit(TEMPLATE))
    expect(ui.status).toBeUndefined()
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  })

  test('in a git repo, a file that still differs from HEAD owes its docs', async ($, on) => {
    setup(on, FILES, { git: { clean: [] } })
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(edit(TEMPLATE))
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/docs\/style-guide\.md/)
  })

  test('a new prompt starts a fresh ledger', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.tool.call(edit(TEMPLATE))
    await $.classic.UserPromptSubmit({ prompt: 'next' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  })

  test('failed edits are not recorded', async ($, on) => {
    setup(on, FILES, { failEdits: true })
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.tool.call(edit(TEMPLATE))
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  })

  test('a waiver with a reason clears the block, is shown and is logged', async ($, on) => {
    const ui = setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.tool.call(edit(TEMPLATE))

    const empty = await $.tool.call({ tool: WAIVE, paths: ['config/templates/home.html'], reason: '  ' } as never)
    expect(String((empty as { result?: unknown }).result)).toMatch(/reason/)

    const ok = await $.tool.call({ tool: WAIVE, paths: ['config/templates/home.html'], reason: 'copy fix only' } as never)
    expect(String((ok as { result?: unknown }).result)).toMatch(/Waived/)
    expect(ui.notices).toEqual(['Doc update waived for home.html: copy fix only'])
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()

    const log = ui.store.get('waivers') as { files: string[]; reason: string }[]
    expect(log).toHaveLength(1)
    expect(log[0]!.reason).toBe('copy fix only')
    expect(log[0]!.files).toEqual([TEMPLATE])
  })
})

// Backlog #26: a subagent that changed mapped files is reminded at its own Stop, once.
describe("a subagent's own Stop", () => {
  const DOC = `${ROOT}/docs/style-guide.md`
  const sub = (agent_id: string, stop_hook_active = false) =>
    ({ stop_hook_active, agent_id, agent_transcript_path: '', agent_type: 'general-purpose' }) as const
  const subEdit = (path: string, agentId: string) => ({ ...edit(path), agentId }) as never
  const loadIn = (agentId: string) => ({ tool: 'Skill', skill: 'schema-rules', agentId }) as never

  test('is blocked once while docs are owed for files it changed; the main Stop still checks', async ($, on) => {
    setup(on, FILES)
    await $.classic.UserPromptSubmit({ prompt: 'go' })
    await $.tool.call(loadIn('a1'))
    await $.tool.call(subEdit(TEMPLATE, 'a1'))

    const first = await $.classic.SubagentStop(sub('a1'))
    expect(first.block).toMatch(/config\/templates\/home\.html/)
    expect(first.block).toMatch(/docs\/style-guide\.md/)
    expect(first.block).toMatch(/not repeated/)
    expect((await $.classic.SubagentStop(sub('a1', true))).block).toBeUndefined()
    // The turn's own check is unchanged.
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toMatch(/config\/templates\/home\.html/)
    // A resumed subagent starts fresh: what it changed before was already reminded.
    expect((await $.classic.SubagentStop(sub('a1'))).block).toBeUndefined()
  })

  test('goes through when the doc was updated this turn, by it or anyone', async ($, on) => {
    setup(on, FILES)
    await $.tool.call(loadIn('a1'))
    await $.tool.call(subEdit(TEMPLATE, 'a1'))
    await $.tool.call(subEdit(DOC, 'a1'))
    expect((await $.classic.SubagentStop(sub('a1'))).block).toBeUndefined()

    await $.tool.call(loadIn('a2'))
    await $.tool.call(subEdit(TEMPLATE, 'a2'))
    expect((await $.classic.SubagentStop(sub('a2'))).block).toBeUndefined()
  })

  test("isn't held up by files other agents or the main thread changed", async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.tool.call(edit(TEMPLATE))
    await $.tool.call(subEdit(`${ROOT}/README.md`, 'a3'))
    expect((await $.classic.SubagentStop(sub('a3'))).block).toBeUndefined()
    expect((await $.classic.SubagentStop(sub('a4'))).block).toBeUndefined()
  })

  test('a waiver it files clears it', async ($, on) => {
    const ui = setup(on, FILES)
    await $.tool.call(loadIn('a1'))
    await $.tool.call(subEdit(TEMPLATE, 'a1'))
    const ok = await $.tool.call({ tool: WAIVE, paths: ['config/templates/home.html'], reason: 'typo fix only', agentId: 'a1' } as never)
    expect(String((ok as { result?: unknown }).result)).toMatch(/Waived/)
    expect(ui.notices).toEqual(['Doc update waived for home.html: typo fix only'])
    expect((await $.classic.SubagentStop(sub('a1'))).block).toBeUndefined()
  })

  test('a change it made before a new prompt still counts at its Stop (a background subagent)', async ($, on) => {
    setup(on, FILES)
    await $.tool.call(loadIn('a1'))
    await $.tool.call(subEdit(TEMPLATE, 'a1'))
    await $.classic.UserPromptSubmit({ prompt: 'meanwhile', source: 'user' })
    expect((await $.classic.SubagentStop(sub('a1'))).block).toMatch(/config\/templates\/home\.html/)
    const ok = await $.tool.call({ tool: WAIVE, paths: ['config/templates/home.html'], reason: 'whitespace only', agentId: 'a1' } as never)
    expect(String((ok as { result?: unknown }).result)).toMatch(/Waived/)
  })

  test('/rules off and /clear', async ($, on) => {
    setup(on, FILES)
    await $.tool.call(loadIn('a1'))
    await $.tool.call(subEdit(TEMPLATE, 'a1'))
    await $.classic.SessionEnd({ reason: 'clear' })
    expect((await $.classic.SubagentStop(sub('a1'))).block).toBeUndefined()

    await $.tool.call(loadIn('a2'))
    await $.tool.call(subEdit(TEMPLATE, 'a2'))
    await $.command.run({ command: 'rules', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect((await $.classic.SubagentStop(sub('a2'))).block).toBeUndefined()
  })
})
