import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { WaiverLogEntry } from '../types'
import {
  ancestors, basename, commandPaths, dirname, join, matchesAny, mentionedFiles, normalize, owedDocs, parseRules,
  blockedBy, relativeTo, requiredSkill, RULES_FILE, skillLoaded, staticPrefix, watchedGlobs, type Owed, type Rules,
} from './rules'

export const PLUGIN = 'rules-enforcer'

export const loadedSkills = atom({ plugin: 'rules-enforcer', key: 'loadedSkills' } as const, [])
export const turnEdits = atom({ plugin: 'rules-enforcer', key: 'turnEdits' } as const, [])
export const waived = atom({ plugin: 'rules-enforcer', key: 'waived' } as const, [])
export const paused = atom({ plugin: 'rules-enforcer', key: 'paused' } as const, false)
export const stopBlocks = atom({ plugin: 'rules-enforcer', key: 'stopBlocks' } as const, 0)
// A subagent's own ledger for its Stop (backlog #26): it can outlive the turn it started in.
export const agentEdits = atom({ plugin: 'rules-enforcer', key: 'agentEdits' } as const, [])
export const subagentReminded = atom({ plugin: 'rules-enforcer', key: 'subagentReminded' } as const, [])
// Rules files whose change scan was cut short at SCAN_MAX and that Claude has been told so (#144).
export const scanNoted = atom({ plugin: 'rules-enforcer', key: 'scanNoted' } as const, [])

// Stop is blocked at most this many times in a row; after that Claude may stop,
// and the user sees the unresolved rule instead of a token-burning loop. Claude
// woken again later in the turn gets one more reminder (backlog #27).
const MAX_STOP_BLOCKS = 3

// loadedSkills holds `<agent>|<skill>`: a skill is in the context of the loop
// that loaded it, so the main thread and each subagent are tracked apart.
// agentEdits holds `<agent>|<abs>` the same way.
const MAIN = 'main'
const agentKey = (agent: string, value: string) => `${agent}|${value}`
const ofAgent = (list: readonly string[], agent: string) =>
  list.filter(k => k.startsWith(`${agent}|`)).map(k => k.slice(agent.length + 1))
const addSkill = ($: EngineInterface, agent: string, skill: string) =>
  update($, loadedSkills, s => (s.includes(agentKey(agent, skill)) ? s : [...s, agentKey(agent, skill)]))
// Skills a subagent is loading through the Skill tool right now; skill.prompt
// carries no agent id, so it must not credit those to the main thread.
const subagentLoading = new Map<string, number>()

// Parse cache keyed by rules-file path; module memory is fine (a reload just re-reads).
const cache = new Map<string, { mtimeMs: number; rules: Rules | null }>()
const warned = new Set<string>()

async function loadRules($: EngineInterface, file: string): Promise<Rules | null> {
  const { mtimeMs } = await $.fs.stat(file)
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.rules
  let rules: Rules | null = null
  try {
    rules = parseRules((await $.fs.read(file)) as string)
  } catch (err) {
    if (!warned.has(file)) {
      warned.add(file)
      $.ui.toast(`${PLUGIN}: ignoring ${file}: ${(err as Error).message}`)
    }
  }
  cache.set(file, { mtimeMs, rules })
  return rules
}

// The rules that apply to each of these folders (or files): the nearest rules file above each,
// keyed by its root, in the order first found. Each folder is looked at once. Any failure
// reading rules counts as "no rules": a broken or vanishing config never blocks work.
async function rootsFor($: EngineInterface, paths: readonly string[]): Promise<Map<string, Rules>> {
  const hasFile = new Map<string, boolean>()
  const out = new Map<string, Rules>()
  for (const path of paths) {
    try {
      for (const dir of ancestors(path)) {
        let has = hasFile.get(dir)
        if (has === undefined) hasFile.set(dir, (has = await $.fs.exists(join(dir, RULES_FILE))))
        if (!has) continue
        if (!out.has(dir)) {
          const rules = await loadRules($, join(dir, RULES_FILE))
          if (rules) out.set(dir, rules)
        }
        break
      }
    } catch {
      // No rules for this one.
    }
  }
  return out
}

export async function rulesFor($: EngineInterface, startDir: string) {
  const [hit] = await rootsFor($, [startDir])
  return hit && { root: hit[0], rules: hit[1] }
}

type EditLike = { tool: string; file_path?: string; notebook_path?: string }
export const targetPath = (e: EditLike) =>
  e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined

export const WAIVE_TOOL = `mcp__${PLUGIN}__waive_doc_update`
export const LOG_KEY = 'waivers'
const LOG_MAX = 200

export async function recordEdit($: EngineInterface, abs: string, agent: string = MAIN): Promise<void> {
  await update($, turnEdits, list => (list.includes(abs) ? list : [...list, abs]))
  if (agent !== MAIN) await update($, agentEdits, list => (list.includes(agentKey(agent, abs)) ? list : [...list, agentKey(agent, abs)]))
  await refreshStatus($)
}

// A file back at its committed version (an edit undone, a `git checkout --`) has no change to
// document (backlog #135). Untracked and ignored files show in the status, so they still count;
// outside git (or if git fails) every edit counts, as before.
async function matchesHead($: EngineInterface, abs: string): Promise<boolean> {
  try {
    const r = await $.process.run(['git', '-C', dirname(abs), '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--ignored', '--', basename(abs)])
    return r.exitCode === 0 && r.stdout.trim() === ''
  } catch {
    return false
  }
}

// What the turn owes. With `changed` (a subagent's own edits), only those files can owe, and a
// doc edited by anyone this turn, or by that subagent, pays.
export async function computeOwed($: EngineInterface, changed?: readonly string[]): Promise<{ root: string; owed: Owed[] }[]> {
  const turn = await read($, turnEdits)
  const edits = changed === undefined ? turn : [...new Set([...turn, ...changed])]
  const w = await read($, waived)
  const groups = new Map<string, { rules: Rules; edited: string[]; changed: string[]; waived: string[] }>()
  for (const abs of edits) {
    const found = await rulesFor($, dirname(abs))
    const rel = found && relativeTo(found.root, abs)
    if (!found || rel === undefined) continue
    if (await matchesHead($, abs)) continue
    const g = groups.get(found.root) ?? { rules: found.rules, edited: [], changed: [], waived: [] }
    g.edited.push(rel)
    if (changed === undefined || changed.includes(abs)) g.changed.push(rel)
    if (w.includes(abs)) g.waived.push(rel)
    groups.set(found.root, g)
  }
  return [...groups]
    .map(([root, g]) => ({ root, owed: owedDocs(g.rules, g.changed, g.waived, g.edited) }))
    .filter(x => x.owed.length > 0)
}

export function describeOwed(groups: { root: string; owed: Owed[] }[], subagent = false): string {
  const lines = groups.flatMap(({ owed }) =>
    owed.map(o => `- ${o.changed.join(', ')} changed, but none of these docs were updated: ${o.rule.docs.join(', ')}`),
  )
  return [
    `Project rule (${RULES_FILE}): docs must be updated in the same turn as the files they describe.`,
    ...lines,
    `Update one of the listed docs, or, if no doc change is genuinely needed, call ${WAIVE_TOOL} with the changed paths and a one-sentence reason.`,
    ...(subagent
      ? ['If updating these docs is not part of your task, say so in your final report and stop: this reminder is not repeated, and the main thread is held to the rule when its turn ends.']
      : []),
  ].join('\n')
}

async function refreshStatus($: EngineInterface) {
  $.ui.status((await computeOwed($)).length > 0 ? 'rules: docs owed' : undefined)
}

// Skill gate shared by the four gated tools; registered once per tool so the
// validator can read each matcher.
// Folders a scan never enters, and a cap so a stray "**" can't walk a huge tree.
const SKIP = new Set(['vendor', 'node_modules', '.git'])
const SCAN_MAX = 5000

// Modification times of every file the rules watch under root, and whether the walk saw all of
// them: it is cut short only when there is an entry past SCAN_MAX (#144). Runs locally; nothing
// here reaches the model.
async function scan($: EngineInterface, root: string, rules: Rules): Promise<{ mtimes: Record<string, number>; complete: boolean }> {
  const globs = watchedGlobs(rules)
  const out: Record<string, number> = {}
  const seen = new Set<string>()
  let budget = SCAN_MAX
  let complete = true
  const walk = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return
    seen.add(dir)
    let entries: readonly FsEntry[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    for (const en of entries) {
      if (budget <= 0) {
        complete = false
        return
      }
      budget--
      const abs = join(dir, en.name)
      if (en.kind === 'dir' && !SKIP.has(en.name)) await walk(abs)
      else if (en.kind === 'file') {
        const rel = relativeTo(root, abs)
        if (rel !== undefined && matchesAny(rel, globs)) out[abs] = en.mtimeMs
      }
    }
  }
  for (const g of globs) {
    const prefix = staticPrefix(g)
    const base = prefix === '' ? root : join(root, prefix)
    if (prefix !== g) {
      await walk(base)
      continue
    }
    try {
      const st = await $.fs.stat(base)
      if (st.kind === 'file') out[base] = st.mtimeMs
    } catch {
      // A watched file that doesn't exist yet.
    }
  }
  return { mtimes: out, complete }
}

const scanCutShort = (rulesFile: string) =>
  `${PLUGIN}: the paths ${rulesFile} watches hold more than ${SCAN_MAX.toLocaleString('en-US')} files and folders, so files Bash commands change are checked only in part. Edits made with Edit or Write are still checked.`

// Skill gate shared by the four gated tools; registered once per tool so the
// validator can read each matcher. For Bash it also scans the watched files
// before and after, since scripts and sed edit files without the Edit tool.
// A command is checked by the rules of the session's folder and of every other
// rules project it works in or names (a `cd` target, a path; backlog #24).
const gate = async ($: EngineInterface, e: unknown, next: (e: unknown) => Promise<{ deny?: string; isError?: boolean; context?: readonly string[] }>) => {
  const call = e as unknown as EditLike & { command?: string; agentId?: string }
  if (await read($, paused)) return next(e)
  const cwd = await $.session.cwd()
  const file = targetPath(call)
  const abs = file === undefined ? undefined : normalize(file, cwd)
  const agent = call.agentId ?? MAIN
  const loaded = ofAgent(await read($, loadedSkills), agent)
  const needs: { skill: string; what: string }[] = []
  const bash: { root: string; rules: Rules; before: Record<string, number>; complete: boolean }[] = []

  if (abs !== undefined) {
    const found = await rulesFor($, dirname(abs))
    const rel = found && relativeTo(found.root, abs)
    const blocked = found && rel !== undefined ? blockedBy(found.rules, { path: rel }) : undefined
    if (blocked) return blockDeny(blocked.rule, `editing ${rel}`)
    const skill = found && rel !== undefined ? requiredSkill(found.rules, { path: rel }) : undefined
    if (skill !== undefined) needs.push({ skill, what: `editing ${rel}` })
  } else if (call.command !== undefined) {
    const command = call.command
    const home = await $.env.get('HOME').catch(() => undefined)
    const roots = await rootsFor($, [cwd, ...commandPaths(command, cwd, home)])
    for (const rules of roots.values()) {
      const blocked = blockedBy(rules, { command })
      if (blocked) return blockDeny(blocked.rule, 'that command')
    }
    for (const [root, rules] of roots) {
      const bySkill = requiredSkill(rules, { command })
      if (bySkill !== undefined) needs.push({ skill: bySkill, what: 'running that command' })
      const { mtimes: before, complete } = await scan($, root, rules)
      const rels = Object.keys(before).map(a => relativeTo(root, a)!)
      for (const rel of mentionedFiles(command, rels)) {
        const skill = requiredSkill(rules, { path: rel })
        if (skill !== undefined) needs.push({ skill, what: `running a command that names ${rel}` })
      }
      bash.push({ root, rules, before, complete })
    }
  }

  const missing = needs.find(n => !skillLoaded(loaded, n.skill))
  if (missing) {
    return { deny: `Project rule (${RULES_FILE}): load the \`${missing.skill}\` skill with the Skill tool before ${missing.what}.` }
  }

  const ran = await next(e)
  if (abs !== undefined && ran.deny === undefined && ran.isError !== true) await recordEdit($, abs, agent)
  if (bash.length === 0 || ran.deny !== undefined) return ran

  // What the command changed on disk, whatever it used to do it.
  const notes: string[] = []
  const cut: string[] = []
  for (const { root, rules, before, complete } of bash) {
    const { mtimes: after, complete: completeAfter } = await scan($, root, rules)
    if (!complete || !completeAfter) cut.push(join(root, RULES_FILE))
    for (const [path, mtime] of Object.entries(after)) {
      if (before[path] === mtime) continue
      await recordEdit($, path, agent)
      const rel = relativeTo(root, path)!
      const skill = requiredSkill(rules, { path: rel })
      if (skill !== undefined && !skillLoaded(loaded, skill)) {
        notes.push(`Project rule (${RULES_FILE}): that command changed ${rel}, which requires the \`${skill}\` skill. Load it now with the Skill tool and review the change against it.`)
      }
    }
  }
  // A scan that stopped at its cap is said once per session per rules file, as a note on the
  // result: nothing is refused because of it (#144).
  if (cut.length > 0) {
    const told = await read($, scanNoted)
    const fresh = cut.filter(f => !told.includes(f))
    if (fresh.length > 0) {
      await update($, scanNoted, list => [...list, ...fresh.filter(f => !list.includes(f))])
      notes.push(...fresh.map(scanCutShort))
    }
  }
  return notes.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
}

// A block rule's refusal: the project's reason, and no unlock (only /rules off, typed, pauses it).
const blockDeny = (rule: { reason: string }, what: string) => ({
  deny: `Project rule (${RULES_FILE}) blocks ${what}: ${rule.reason} Don't try to do it another way.`,
})

const gateFailed = { deny: `${PLUGIN}: the skill gate failed, so the call was refused. /rules off bypasses it.` }

export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, gate as never).catch(($, e, next) => (next.called ? next(e) : gateFailed))
  on('tool.call', { tool: 'Write' }, gate as never).catch(($, e, next) => (next.called ? next(e) : gateFailed))
  on('tool.call', { tool: 'NotebookEdit' }, gate as never).catch(($, e, next) => (next.called ? next(e) : gateFailed))
  on('tool.call', { tool: 'Bash' }, gate as never).catch(($, e, next) => (next.called ? next(e) : gateFailed))
  // Monitor runs shell commands too.
  on('tool.call', { tool: 'Monitor' }, gate as never).catch(($, e, next) => (next.called ? next(e) : gateFailed))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const { skill, agentId } = e as unknown as { skill: string; agentId?: string }
    const agent = agentId ?? MAIN
    if (agent !== MAIN) subagentLoading.set(skill, (subagentLoading.get(skill) ?? 0) + 1)
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) await addSkill($, agent, skill)
      return ran
    } finally {
      if (agent !== MAIN) {
        const n = (subagentLoading.get(skill) ?? 1) - 1
        if (n > 0) subagentLoading.set(skill, n)
        else subagentLoading.delete(skill)
      }
    }
  })

  // Covers a skill typed as /name (and the main thread's Skill tool calls again).
  on('skill.prompt', async ($, e, next) => {
    const ran = await next(e)
    if (!subagentLoading.has(e.skill)) await addSkill($, MAIN, e.skill)
    return ran
  })

  on('classic.SessionEnd', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, loadedSkills, () => [])
      await update($, turnEdits, () => [])
      await update($, waived, () => [])
      await update($, stopBlocks, () => 0)
      await update($, agentEdits, () => [])
      await update($, subagentReminded, () => [])
      await update($, scanNoted, () => [])
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    await update($, loadedSkills, () => [])
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'waive_doc_update',
      description:
        'Waive a project doc-sync rule for files changed this turn when no doc update is genuinely needed ' +
        '(e.g. a bug fix that changes no documented value). Requires a one-sentence reason; the waiver is shown to the user and logged.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Changed files, as named in the Stop message' },
          reason: { type: 'string', description: 'Why no doc update is needed' },
        },
        required: ['paths', 'reason'],
      },
    })
    await $.command.register({ name: 'rules', description: 'Project rules status; /rules on|off|log' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__rules-enforcer__waive_doc_update' }, async ($, e) => {
    const { paths, reason, tool_use_id, agentId } = e as unknown as { paths?: unknown; reason?: unknown; tool_use_id: string; agentId?: string }
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === 'string')) {
      return { result: 'paths must be a non-empty list of file paths.' }
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { result: 'A non-empty reason is required to waive a doc update.' }
    }
    const cwd = await $.session.cwd()
    const wanted = (paths as string[]).map(p => p.replace(/^\.\//, ''))
    // A subagent's own edits count too: it may have outlived the turn it made them in.
    const own = agentId === undefined ? [] : ofAgent(await read($, agentEdits), agentId)
    const hits = [...new Set([...(await read($, turnEdits)), ...own])].filter(abs =>
      wanted.some(p => abs === normalize(p, cwd) || abs.endsWith(`/${p}`)),
    )
    if (hits.length === 0) {
      return { result: `No file edited this turn matches ${wanted.join(', ')}. Use the paths named in the Stop message.` }
    }
    await update($, waived, w => [...new Set([...w, ...hits])])
    const names = hits.map(basename).join(', ')
    $.ui.notice(tool_use_id, `Doc update waived for ${names}: ${reason.trim()}`)
    const log = ((await $.store.get(LOG_KEY)) as WaiverLogEntry[] | undefined) ?? []
    await $.store.set(LOG_KEY, [...log, { at: await $.clock.now(), files: hits, reason: reason.trim() }].slice(-LOG_MAX))
    await refreshStatus($)
    return { result: `Waived: ${names}.` }
  })

  // Only a prompt from the person (or an SDK caller) starts a new turn's ledger;
  // system-injected prompts (task notifications, auto-continuations) do not.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.source === undefined || e.source === 'user' || e.source === 'sdk') {
      await update($, turnEdits, () => [])
      await update($, waived, () => [])
      await update($, stopBlocks, () => 0)
      $.ui.status(undefined)
    }
    return next(e)
  })

  // Fails open: a hook that throws is skipped, so Claude is never trapped by a bug here.
  on('classic.Stop', async ($, e, next) => {
    if (await read($, paused)) return next(e)
    const owed = await computeOwed($)
    if (owed.length === 0) {
      $.ui.status(undefined)
      return next(e)
    }
    const blocks = await read($, stopBlocks)
    if (e.stop_hook_active && blocks >= MAX_STOP_BLOCKS) {
      $.ui.status('rules: docs owed (unresolved)')
      $.ui.toast(`${PLUGIN}: stopped with doc updates unresolved after ${blocks} reminders. /rules shows what is owed.`)
      return next(e)
    }
    await update($, stopBlocks, n => n + 1)
    return { block: describeOwed(owed) }
  })

  // A subagent's own Stop (backlog #26): docs owed for files it changed are put to it once, while
  // it still has the context; a doc anyone updated this turn pays. Its second Stop goes through,
  // since the docs may be another agent's part of the work, and the main Stop still holds the
  // turn to the rule. Once it stops, its ledger is cleared: a resumed subagent starts fresh.
  on('classic.SubagentStop', async ($, e, next) => {
    if (await read($, paused)) return next(e)
    const agent = e.agent_id
    const mine = ofAgent(await read($, agentEdits), agent)
    const reminded = (await read($, subagentReminded)).includes(agent)
    if (mine.length > 0 && !reminded) {
      const owed = await computeOwed($, mine)
      if (owed.length > 0) {
        await update($, subagentReminded, s => [...s, agent])
        return { block: describeOwed(owed, true) }
      }
    }
    await update($, agentEdits, s => s.filter(k => !k.startsWith(`${agent}|`)))
    if (reminded) await update($, subagentReminded, s => s.filter(a => a !== agent))
    return next(e)
  })

  on('command.run', { command: 'rules' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await update($, paused, () => arg === 'off')
      if (arg === 'off') $.ui.status(undefined)
      return { text: `Rules enforcement ${arg === 'off' ? 'paused' : 'on'} for this session.` }
    }
    if (arg === 'log') {
      const log = ((await $.store.get(LOG_KEY)) as WaiverLogEntry[] | undefined) ?? []
      if (log.length === 0) return { text: 'No doc-update waivers recorded.' }
      return {
        text: log
          .slice(-20)
          .map(w => `${new Date(w.at).toISOString().slice(0, 16)}  ${w.files.map(basename).join(', ')}: ${w.reason}`)
          .join('\n'),
      }
    }
    const found = await rulesFor($, await $.session.cwd())
    if (!found) return { text: `No ${RULES_FILE} applies here.` }
    const skills = ofAgent(await read($, loadedSkills), MAIN)
    const owed = await computeOwed($)
    return {
      text: [
        `Rules: ${join(found.root, RULES_FILE)}${(await read($, paused)) ? ' (paused)' : ''}`,
        `Skill rules: ${found.rules.skills.length}, doc rules: ${found.rules.docs.length}, block rules: ${found.rules.block.length}`,
        `Skills loaded this session: ${skills.length > 0 ? skills.join(', ') : 'none'}`,
        owed.length > 0 ? describeOwed(owed) : 'Nothing owed this turn.',
      ].join('\n'),
    }
  })
}
