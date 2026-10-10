# modbar

Draws the area above the prompt for other mods. Each mod hands modbar blocks (text, buttons and bars), and modbar packs them into rows. It is the one place to hide, show or arrange anything above the prompt. The first row is kept blank for Claude Code's own `[-]`.

## Commands

- `/modbar` (or `/modbar list`): lists the blocks shown, with their ids, owners, widths and order, then the blocks you can add: those a mod offers off by default and those you've hidden.
- `/modbar add <id>` and `/modbar remove <id>` (or `show` and `hide`): show or hide a block. A mod's name (e.g. `context-bar`) stands for all its blocks.
- `/modbar width <id> full|half|third|fit|fill`: how much of a row a block takes. `full` gives it its own row; `half` and `third` share a row; `fit` takes what its content needs; `fill` takes what the others leave.
- `/modbar align <id> left|right` and `/modbar order <id> <n>`: placement within a row, and the order of blocks. A right-aligned block goes to the right end of its row when the row has room.
- An edit to an id that no mod offers right now still applies, since some blocks only appear at times. The answer says the id isn't offered, in case it's a typo.
- `/modbar reload`: re-read the settings file.
- `/modbar reset confirm`: clear all modbar settings.

## Settings

The commands above write `~/.claude/modbar.json`. You don't need to edit it by hand. If the file can't be read, modbar shows one notice and uses its defaults.

## For mod authors

A mod answers modbar's hook with its blocks. A block with `off: true` isn't drawn until the user runs `/modbar show <id>`, and its `about` text describes it in `/modbar`'s list. `types/index.d.ts` describes the contract.

If your mod only draws blocks (as context-bar does), list modbar under `dependencies` in your `plugin.json`: without modbar there is nothing for it to do, and Claude Code then turns it off.

If your mod does useful work without modbar (as handoff and context-diet do), let it keep working when modbar isn't loaded, with only its blocks undrawn. Do two things:

- Add modbar's noun yourself, beneath whatever is already there, with this line at the top of your `register`. Claude Code refuses a module that hooks a noun no loaded plugin provides; with this line, whichever mod is built first provides the same core (no blocks, no press taken), and none replaces another's. Keep the core exactly as here.

  ```ts
  on('engine.create', async ($, e, next) => ({ modbar: { blocks: async () => [], press: async () => false }, ...(await next(e)) }) as never)
  ```

- Don't list modbar under `dependencies` in your `plugin.json`: Claude Code turns a mod off when a plugin it lists there isn't loaded. Tell your users to install modbar to see your blocks.

To test your hooks, load a stand-in for modbar beside your mod (an inline plugin in the test): it adds the `modbar` noun in `engine.create` and calls `$.modbar.blocks` or `$.modbar.press` from a command of its own, so your real hooks answer. The test's own `$` doesn't carry other mods' nouns. context-bar's tests show how.
