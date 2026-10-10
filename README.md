# claude-mods

Mods (function-hook plugins) for Claude Code.

| Mod | What it does |
|---|---|
| [`modbar`](modbar/) | Draws the area above the prompt for the other mods. They hand it blocks, and it packs them into rows. `/modbar` lists the blocks and arranges them. |
| [`context-bar`](context-bar/) | Shows the context window as a stacked bar with its percentage and a legend, drawn by modbar. |
| [`context-diet`](context-diet/) | Removes escape codes, progress redraws and runs of identical lines from Bash output (lossless only), and lists the biggest items in context. |
| [`handoff`](handoff/) | Keeps a note per project folder for the next session: `/handoff` writes a full one; with `/handoff auto on`, exit also saves a quick one when work happened. |

context-bar and handoff draw through modbar, so install modbar with them. context-diet works on its own; with it loaded, context-bar adds a line showing the biggest items in context.

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

Then list the mod folders in `~/.claude/settings.json`, separated by `:`, with modbar first:

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
