# modbar

Draws the area above the prompt for other mods. Each mod hands modbar blocks (text, buttons and bars), and modbar packs them into rows. It is the one place to hide, show or arrange anything above the prompt. The first row is kept blank for Claude Code's own `[-]`.

## Commands

- `/modbar`: lists the blocks with their ids, owners, widths and order.
- `/modbar hide <id>` and `/modbar show <id>`: hide or show a block. A mod's name (e.g. `context-bar`) stands for all its blocks.
- `/modbar width <id> full|half|third|fit|fill`: how much of a row a block takes. `full` gives it its own row; `half` and `third` share a row; `fit` takes what its content needs; `fill` takes what the others leave.
- `/modbar align <id> left|right` and `/modbar order <id> <n>`: placement within a row, and the order of blocks.
- `/modbar reload`: re-read the settings file.
- `/modbar reset confirm`: clear all modbar settings.

## Settings

The commands above write `~/.claude/modbar.json`. You don't need to edit it by hand. If the file can't be read, modbar shows one notice and uses its defaults.

## For mod authors

A mod declares `"dependencies": ["modbar"]` and answers modbar's hook with its blocks. `types/index.d.ts` describes the contract.
