# claude-mods

Mods (function-hook plugins) for Claude Code.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Mod&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | What it does |
|---|---|
| [`modbar`](modbar/) | Draws the area above the prompt for the other mods. They hand it blocks, and it packs them into rows. <code>/&#8288;modbar</code> lists the blocks shown and the ones you can add, and arranges them. |
| [`context-bar`](context-bar/) | Shows the context window as a stacked bar with its percentage and a legend, drawn by modbar. |
| [`context-diet`](context-diet/) | Removes escape codes, progress redraws and runs of identical lines from Bash output (lossless only), and lists the biggest items in context. |
| [`handoff`](handoff/) | Keeps a note per project folder for the next session: <code>/&#8288;handoff</code> writes a full one; with <code>/&#8288;handoff&nbsp;auto&nbsp;on</code>, exit also saves a quick one when work happened. |

context-bar, context-diet and handoff draw through modbar, so install modbar with them. context-diet shows the tokens its cleanup saved, and offers a row with the biggest items in context that is off until you run <code>/&#8288;modbar&nbsp;add&nbsp;context-diet.top</code>.

None of the mods needs configuration.

## Install

### From the marketplace

```
claude plugin marketplace add lnodonly/claude-mods
claude plugin install modbar@claude-mods
claude plugin install context-bar@claude-mods
claude plugin install context-diet@claude-mods
claude plugin install handoff@claude-mods
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
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/modbar:/path/to/claude-mods/context-bar:/path/to/claude-mods/context-diet:/path/to/claude-mods/handoff"
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
