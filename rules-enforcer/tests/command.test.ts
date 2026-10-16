import { describe, expect, test } from 'claude-code/testing'

import { edit, ROOT, RULES_JSON, setup } from './fixtures'

const FILES = { [`${ROOT}/.claude/rules.json`]: RULES_JSON }
const run = (args: string) => ({
  command: 'rules',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

describe('/rules', () => {
  test('off disables both checks; on restores them', async ($, on) => {
    setup(on, FILES)
    expect((await $.command.run(run('off'))).text).toMatch(/paused/)
    expect((await $.tool.call(edit(`${ROOT}/config/templates/home.html`))).deny).toBeUndefined()
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()

    expect((await $.command.run(run('on'))).text).toMatch(/on/)
    expect((await $.tool.call(edit(`${ROOT}/config/schema.json`))).deny).toBeDefined()
  })

  test('status shows the rules file, loaded skills and what is owed', async ($, on) => {
    setup(on, FILES)
    await $.tool.call({ tool: 'Skill', skill: 'schema-rules' })
    await $.tool.call(edit(`${ROOT}/config/templates/home.html`))
    const { text } = await $.command.run(run(''))
    expect(text).toMatch(/\/p\/\.claude\/rules\.json/)
    expect(text).toMatch(/schema-rules/)
    expect(text).toMatch(/docs\/style-guide\.md/)
  })

  test('status outside a rules project says so', async ($, on) => {
    setup(on, {}, { cwd: '/nowhere' })
    expect((await $.command.run(run(''))).text).toMatch(/No \.claude\/rules\.json/)
  })

  test('log lists recent waivers', async ($, on) => {
    const ui = setup(on, FILES)
    expect((await $.command.run(run('log'))).text).toMatch(/No doc-update waivers/)
    ui.store.set('waivers', [{ at: 0, files: ['/p/config/style.css'], reason: 'css-only fix' }])
    expect((await $.command.run(run('log'))).text).toMatch(/style\.css.*css-only fix/)
  })
})
