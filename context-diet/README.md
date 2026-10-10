# context-diet

Bash output often carries colour codes, progress bars that redraw themselves, and long runs of identical lines. All of it costs context. context-diet cleans each Bash result before Claude sees it, keeping what a terminal would show once the command had finished:

- Escape codes (colours, cursor moves, window titles, inline images) are removed.
- Progress redraws (`\r` frames, cursor moves and erases within a line) collapse to their final state.
- A run of identical lines becomes one line with `[×N identical lines]`, when that is shorter. If the output already has a line ending that way, nothing is collapsed and Claude is told the line is the command's own text.

When output is too large to show inline and is saved to a file, the saved file is cleaned too: a cleaned copy is written beside it (`<name>.clean.<ext>`) and Claude is pointed at it, with its real size. When Claude reads a background command's output file with the Read tool, escape codes and redraws are removed there as well, and every line is kept so line numbers still match.

The cleanup is lossless: it never summarizes or drops content. An error result or a refused command passes through untouched. If anything fails, the original output is kept.

## Commands

- `/context-diet`: lists the ten biggest items in context (estimated tokens) and the tokens saved this session.
- `/context-diet off` and `/context-diet on`: pause or resume the cleanup. The setting lasts across sessions.

[modbar](../modbar/) shows the tokens saved above the prompt (`context-diet.saved`). A row with the top three items (`context-diet.top`) is off until you run `/modbar add context-diet.top`. `/modbar` lists it under what can be added. `/modbar remove <id>` turns either one off. Without modbar, the cleanup and `/context-diet` still work; only these blocks are missing.

## Limits

- Token figures are estimates (characters ÷ 4).
- Other files Claude reads with the Read tool aren't cleaned. A saved output over 4 MiB keeps its raw file (its preview is still cleaned).
- Cursor moves between lines are removed but not replayed, so some multi-line progress displays keep intermediate frames. Commands run without a terminal, so few tools draw such displays.
- Escape codes are removed even where they matter. Use `/context-diet off`, or show them as text with `cat -v` or `od -c`.
