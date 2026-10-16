# rules-enforcer

Turns a project's "always do X" rules into deterministic checks. Some rules live in CLAUDE.md as prose that Claude can still skip; this mod reads them from a project's `.claude/rules.json` and enforces them at the tool call, so a rule can't be skipped without leaving a visible record. When no rule is broken it says nothing and costs no tokens.

It is **inactive until a project has a `.claude/rules.json`**. A project with no rules file is never affected.

## The rules file

`<project>/.claude/rules.json`, checked into the project so teammates get it too:

```json
{
  "skills": [
    { "paths": ["config/schema.json", "config/templates/**"], "skill": "schema-rules" },
    { "commands": ["^\\s*migrate\\s"], "skill": "db-migrations" }
  ],
  "docs": [
    { "paths": ["config/templates/*.html"], "docs": ["docs/style-guide.md"] }
  ],
  "block": [
    { "commands": ["deploy\\.sh"], "reason": "Deploys run through CI." }
  ]
}
```

- **`paths`** are globs relative to the rules root (the folder holding `.claude/rules.json`). `*` matches within one path segment, `**` across segments. A leading `./` is dropped; an absolute path or a `..` segment is invalid. Only files inside the rules root can match.
- **`commands`** are JavaScript regular expressions tested against the Bash command string.
- **`docs`** are paths relative to the rules root; a doc rule is satisfied when **any** of its docs is edited in the same turn.
- A missing file means no rules. A malformed one warns once per session (a toast) and is treated as no rules — a broken config never blocks work.

## What it enforces

- **Skill gate.** If a `skills` rule matches an edit (Edit, Write, NotebookEdit by path) or a Bash command, and that skill hasn't been loaded since the session started or the last compaction, the call is refused: *"load the `schema-rules` skill with the Skill tool before editing config/schema.json."* Claude loads the skill and retries. Loads are tracked per agent and reset on compaction and `/clear`. A Bash command that names a gated file (by path or file name), reads included, needs its skill too.
- **Doc sync.** When an edit matches a `docs` rule's `paths` and none of that rule's `docs` were edited in the same turn, the turn's Stop is blocked with what's owed. Editing one of the docs, or filing a waiver, clears it. Stop is blocked at most 3 times in a row, then Claude may stop with docs still owed (you get a toast and a `rules: docs owed (unresolved)` status). A subagent is reminded once at its own Stop; the main thread's Stop holds the turn to the rule.
- **Block.** A `block` rule refuses a command whose regex matches anywhere in its text — as written or with quotes and backslashes dropped, so `dep'loy'.sh` and `\deploy.sh` still match `deploy\.sh` (this covers wrappers like `bash -c "…"`). A `paths` block refuses Edit, Write and NotebookEdit on matching files. The refusal names the rule's `reason`. A block is checked before the skill gate — loading a skill doesn't lift it. A block is a guard against accidents, not a sandbox.

## Commands

- `/rules`: the active rules root and rule counts, the skills loaded this session, and what's owed this turn.
- `/rules off` and `/rules on`: pause or resume enforcement for this session (blocks included while paused).
- `/rules log`: recent waivers.
- `waive_doc_update({ paths, reason })` (listed as `mcp__rules-enforcer__waive_doc_update`): marks the owed doc rules matching those paths as satisfied for this turn. Requires a non-empty reason; each waiver is shown as a notice and logged.

## Limits

- Bash edits are detected on disk: before and after each Bash (or Monitor) command in a rules project, the mod reads the modification times of the watched files (skill-gated, doc-mapped and the docs), skipping `vendor`, `node_modules` and `.git`, capped at 5,000 entries per scan. Past the cap you're told once per session that changes are checked only in part. A gated file a command changes without naming it can't be refused (the change already happened); a note on the result asks Claude to load the skill and review it.
- Rules roots are found from the session's working directory and the folders a command's text names (`cd`/`pushd` targets, path-shaped words). A folder the text doesn't spell out (held in a variable, a command substitution, `cd -`) isn't found.
- A block is not a sandbox: Claude could reach the same effect by a route the regex doesn't name, and `.claude/rules.json` itself can be edited. Use a Claude Code `permissions.deny` rule for a hard boundary.
