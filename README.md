# claude-mods

Mods (function-hook plugins) for Claude Code.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Mod&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | What it does |
|---|---|
| [`modbar`](modbar/) | Draws the area above the prompt for the other mods. They hand it blocks, and it packs them into rows. <code>/&#8288;modbar</code> lists the blocks shown and the ones you can add, and arranges them. |
| [`context-bar`](context-bar/) | Shows the context window as a stacked bar with its percentage and a legend, drawn by modbar. |
| [`context-diet`](context-diet/) | Removes escape codes, progress redraws and runs of identical lines from Bash output (lossless only), and lists the biggest items in context. |
| [`handoff`](handoff/) | Keeps a note per project folder for the next session: <code>/&#8288;handoff</code> writes a full one; with <code>/&#8288;handoff&nbsp;auto&nbsp;on</code>, exit also saves a quick one when work happened. |
| [`rules-enforcer`](rules-enforcer/) | Enforces a project's <code>.claude/rules.json</code>: it can require a skill be loaded before matching files are edited or matching commands run, owe a doc update in the same turn when a mapped file changes, and block listed commands or paths. Active only in a project that has a <code>.claude/rules.json</code>. |

context-bar draws through modbar, so install modbar with it. context-diet and handoff work on their own, and with modbar they also show their blocks. context-diet shows the tokens its cleanup saved, and offers a row with the biggest items in context that is off until you run <code>/&#8288;modbar&nbsp;add&nbsp;context-diet.top</code>.

modbar, context-bar, context-diet and handoff need no configuration. rules-enforcer does nothing until a project has a <code>.claude/rules.json</code>; it reads its rules from that file and stays inactive everywhere else.

## Install

### From the marketplace

```
claude plugin marketplace add lnodonly/claude-mods
claude plugin install modbar@claude-mods
claude plugin install context-bar@claude-mods
claude plugin install context-diet@claude-mods
claude plugin install handoff@claude-mods
claude plugin install rules-enforcer@claude-mods
```

Restart Claude Code afterwards. `claude plugin update <name>` picks up new versions.

### From a clone

```
git clone https://github.com/lnodonly/claude-mods.git ~/claude-mods
```

Then list the mod folders in `~/.claude/settings.json`, separated by `:`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/modbar:/path/to/claude-mods/context-bar:/path/to/claude-mods/context-diet:/path/to/claude-mods/handoff:/path/to/claude-mods/rules-enforcer"
  }
}
```

Use full paths. Restart Claude Code. Loaded this way, a mod reloads when you save one of its files.

## Development

```
claude plugin test ./<mod>
claude plugin validate ./<mod>
```

## License

MIT
