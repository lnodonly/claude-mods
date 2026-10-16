export type SkillRule = { paths?: string[]; commands?: string[]; skill: string }
export type DocRule = { paths: string[]; docs: string[] }
// Never allowed in this project: a Bash or Monitor command matching a regex, or an edit to a
// matching file. `reason` is what Claude is told.
export type BlockRule = { commands?: string[]; paths?: string[]; reason: string }
export type Rules = { skills: SkillRule[]; docs: DocRule[]; block: BlockRule[] }
export type Owed = { rule: DocRule; changed: string[] }

export const RULES_FILE = '.claude/rules.json'

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.length > 0)

// Rule paths are relative to the rules root: a leading ./ is dropped, and an
// absolute path or a .. segment could never match, so they are rejected.
function relPath(p: string, where: string): string {
  if (p.startsWith('/')) throw new Error(`${where}: "${p}" must be relative to the rules root`)
  const out = p.replace(/^(\.\/)+/, '')
  if (out.split('/').includes('..')) throw new Error(`${where}: "${p}" may not contain ..`)
  return out
}

export function parseRules(text: string): Rules {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('top level must be an object')
  const { skills = [], docs = [], block = [] } = raw as { skills?: unknown; docs?: unknown; block?: unknown }
  if (!Array.isArray(skills)) throw new Error('"skills" must be an array')
  if (!Array.isArray(docs)) throw new Error('"docs" must be an array')
  if (!Array.isArray(block)) throw new Error('"block" must be an array')

  const outSkills: SkillRule[] = skills.map((r: unknown, i) => {
    const { paths, commands, skill } = (r ?? {}) as Partial<SkillRule>
    if (typeof skill !== 'string' || skill.length === 0) throw new Error(`skills[${i}] needs a "skill" name`)
    if (paths === undefined && commands === undefined) throw new Error(`skills[${i}] needs paths or commands`)
    if (paths !== undefined && !isStrings(paths)) throw new Error(`skills[${i}].paths must be non-empty strings`)
    if (commands !== undefined && !isStrings(commands)) throw new Error(`skills[${i}].commands must be non-empty strings`)
    for (const c of commands ?? []) {
      try {
        new RegExp(c)
      } catch {
        throw new Error(`skills[${i}] has an invalid regex: ${c}`)
      }
    }
    const rel = paths?.map(p => relPath(p, `skills[${i}].paths`))
    return { ...(rel && { paths: rel }), ...(commands && { commands }), skill }
  })

  const outDocs: DocRule[] = docs.map((r: unknown, i) => {
    const { paths, docs: d } = (r ?? {}) as Partial<DocRule>
    if (!isStrings(paths)) throw new Error(`docs[${i}].paths must be non-empty strings`)
    if (!isStrings(d)) throw new Error(`docs[${i}].docs must be non-empty strings`)
    return { paths: paths.map(p => relPath(p, `docs[${i}].paths`)), docs: d.map(p => relPath(p, `docs[${i}].docs`)) }
  })

  const outBlock: BlockRule[] = block.map((r: unknown, i) => {
    const { commands, paths, reason } = (r ?? {}) as Partial<BlockRule>
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`block[${i}] needs a "reason" (what Claude is told)`)
    if (paths === undefined && commands === undefined) throw new Error(`block[${i}] needs paths or commands`)
    if (paths !== undefined && !isStrings(paths)) throw new Error(`block[${i}].paths must be non-empty strings`)
    if (commands !== undefined && !isStrings(commands)) throw new Error(`block[${i}].commands must be non-empty strings`)
    for (const c of commands ?? []) {
      try {
        new RegExp(c)
      } catch {
        throw new Error(`block[${i}] has an invalid regex: ${c}`)
      }
    }
    const rel = paths?.map(p => relPath(p, `block[${i}].paths`))
    return { ...(commands && { commands }), ...(rel && { paths: rel }), reason: reason.trim() }
  })

  return { skills: outSkills, docs: outDocs, block: outBlock }
}

// A command as matched for blocking: as written, and with quotes and backslashes dropped, so
// `dep'loy'.sh` or `\deploy.sh` still matches deploy\.sh.
const flatten = (command: string) => command.replace(/['"\\]/g, '')

// The block rule a call breaks, if any: a command whose text matches anywhere, or an edited path.
export function blockedBy(rules: Rules, target: { path?: string; command?: string }): { rule: BlockRule; match: string } | undefined {
  for (const rule of rules.block) {
    if (target.command !== undefined) {
      const forms = [target.command, flatten(target.command)]
      const hit = rule.commands?.find(c => forms.some(f => new RegExp(c).test(f)))
      if (hit !== undefined) return { rule, match: hit }
    }
    if (target.path !== undefined) {
      const hit = rule.paths?.find(g => globToRegExp(g).test(target.path!))
      if (hit !== undefined) return { rule, match: hit }
    }
  }
  return undefined
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (rel: string, globs: readonly string[]) => globs.some(g => globToRegExp(g).test(rel))

export function normalize(path: string, cwd: string): string {
  const parts: string[] = []
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

export const dirname = (abs: string) => abs.slice(0, abs.lastIndexOf('/')) || '/'
export const basename = (abs: string) => abs.slice(abs.lastIndexOf('/') + 1)
export const join = (dir: string, rel: string) => (dir === '/' ? `/${rel}` : `${dir}/${rel}`)

export function ancestors(dir: string): string[] {
  const out = [dir]
  while (out[out.length - 1] !== '/') out.push(dirname(out[out.length - 1]!))
  return out
}

export function relativeTo(root: string, abs: string): string | undefined {
  const prefix = root === '/' ? '/' : `${root}/`
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : undefined
}

export function requiredSkill(rules: Rules, target: { path?: string; command?: string }): string | undefined {
  for (const r of rules.skills) {
    if (target.path !== undefined && r.paths && matchesAny(target.path, r.paths)) return r.skill
    if (target.command !== undefined && r.commands?.some(c => new RegExp(c).test(target.command!))) return r.skill
  }
  return undefined
}

export const skillLoaded = (loaded: readonly string[], skill: string) =>
  loaded.some(s => s === skill || s.endsWith(`:${skill}`))

// Doc rules owed for the edited files. A rule's docs count as updated when any of them is in
// docsEdited (by default the same edits; a subagent's check passes the whole turn's).
export function owedDocs(rules: Rules, edited: readonly string[], waived: readonly string[], docsEdited: readonly string[] = edited): Owed[] {
  const out: Owed[] = []
  for (const rule of rules.docs) {
    const changed = edited.filter(p => matchesAny(p, rule.paths) && !waived.includes(p))
    if (changed.length > 0 && !rule.docs.some(d => docsEdited.includes(d))) out.push({ rule, changed })
  }
  return out
}

// Every path a rules file watches: skill-gated files, doc-mapped files, and the docs.
export const watchedGlobs = (rules: Rules) => [
  ...rules.skills.flatMap(r => r.paths ?? []),
  ...rules.docs.flatMap(r => [...r.paths, ...r.docs]),
]

// The leading segments of a glob before any wildcard: where a scan starts.
export function staticPrefix(glob: string): string {
  const out: string[] = []
  for (const seg of glob.split('/')) {
    if (/[*?]/.test(seg)) break
    out.push(seg)
  }
  return out.join('/')
}

// Root-relative files a shell command names, by relative path or by file name.
export const mentionedFiles = (command: string, rels: readonly string[]) =>
  rels.filter(rel => command.includes(rel) || command.includes(basename(rel)))

const SHELL_OPS = ';&|()<>\n'
const HAS_SPACE_OR_OP = /[\s;&|()<>]/

// The words of a shell command, roughly as the shell splits them: quotes removed, a backslash
// keeps the next character, and ; & | ( ) < > stand alone (a line break counts as ;). A word
// holding spaces or operators (`bash -c "cd /p && make"`, or a heredoc's text that a stray
// apostrophe turned into one long quote) is followed by its own words, so a command inside a
// string is read too, at any depth of quoting: each of its words is shorter than it (a space or
// operator splits, or quotes are removed), so this ends. Over-reading is safe here: the words
// only say which folders to check.
export function shellWords(command: string): string[] {
  const out: string[] = []
  let word = ''
  let started = false
  let quote: string | undefined
  const end = () => {
    if (!started) return
    out.push(word)
    if (HAS_SPACE_OR_OP.test(word)) out.push(...shellWords(word))
    word = ''
    started = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      started = true
    } else if (SHELL_OPS.includes(c)) {
      end()
      out.push(c === '\n' ? ';' : c)
    } else if (/\s/.test(c)) end()
    else {
      word += c
      started = true
    }
  }
  end()
  return out
}

const isShellOp = (w: string) => w.length === 1 && SHELL_OPS.includes(w)
const HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/
const PATH_START = /^(\/|~|\$HOME\b|\$\{HOME\}|\.\.(\/|$))/

// A word that names a path: it starts like one, or it holds a / and no spaces. `--out=/x` and
// `VAR=/x` name the part after the =.
function pathWord(word: string): string | undefined {
  const eq = word.indexOf('=')
  const slash = word.indexOf('/')
  const w = eq > 0 && (slash === -1 || eq < slash) ? word.slice(eq + 1) : word
  return PATH_START.test(w) || (w.includes('/') && !HAS_SPACE_OR_OP.test(w)) ? w : undefined
}

// A path word made absolute from dir. `~`, `$HOME` and `${HOME}` become home; a glob is cut at
// its first wildcard; a word that starts with another variable or a command substitution, a
// URL, or `~` with no known home gives nothing.
function resolveWord(word: string, dir: string, home: string | undefined): string | undefined {
  let w = word
  const h = HOME_PREFIX.exec(w)
  if (h) {
    if (home === undefined) return undefined
    w = home + w.slice(h[0].length)
  } else if (w.startsWith('~')) return undefined
  const cut = w.search(/[*?[$`]/)
  if (cut === 0) return undefined
  if (cut > 0) w = w.slice(0, cut)
  if (/^[a-z][a-z0-9+.-]*:\//i.test(w)) return undefined
  return normalize(w, dir)
}

// Absolute paths a shell command works in or names, besides the session's folder (backlog #24):
// each `cd` or `pushd` target, and each word that is a path, both resolved from the folder the
// command is in by then. The rules roots above them are the projects the command can touch.
// Every one is returned, however many: a guard doesn't skip inputs (the caller looks each
// folder up once, so a long script costs a stat per new folder).
export function commandPaths(command: string, cwd: string, home: string | undefined): string[] {
  const words = shellWords(command)
  const out = new Set<string>()
  const add = (p: string | undefined) => {
    if (p !== undefined) out.add(p)
  }
  let dir = cwd
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === 'cd' || w === 'pushd') {
      let j = i + 1
      while (j < words.length && /^-./.test(words[j]!)) j++
      const target = words[j]
      i = j
      if (target === undefined || isShellOp(target)) {
        if (home !== undefined) add((dir = home))
        i = j - 1
      } else if (target !== '-') {
        const p = resolveWord(target, dir, home)
        if (p !== undefined) add((dir = p))
      }
      continue
    }
    const p = pathWord(w)
    if (p !== undefined) add(resolveWord(p, dir, home))
  }
  return [...out]
}
