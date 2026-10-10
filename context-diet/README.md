# context-diet

Bash output often carries colour codes, progress bars that redraw themselves, and long runs of identical lines. All of it costs context. context-diet cleans each Bash result before Claude sees it, keeping what a terminal would show once the command had finished:

- Escape codes (colours, cursor moves, window titles) are removed.
- Progress redraws (`\r` frames) collapse to their final state.
- A run of identical lines becomes one line with `[×N identical lines]`, when that is shorter.

The cleanup is lossless: it never summarizes or drops content. An error result or a refused command passes through untouched. If anything fails, the original output is kept.

## Commands

- `/context-diet`: lists the ten biggest items in context (estimated tokens) and the tokens saved this session.
- `/context-diet off` and `/context-diet on`: pause or resume the cleanup. The setting lasts across sessions.

Requires [modbar](../modbar/), which shows the tokens saved above the prompt (`context-diet.saved`). A row with the top three items (`context-diet.top`) is off until you run `/modbar add context-diet.top`. `/modbar` lists it under what can be added. `/modbar remove <id>` turns either one off.

## Limits

- Token figures are estimates (characters ÷ 4).
- Output Claude reads from a file with the Read tool, such as a background command's output, isn't cleaned.
- Cursor moves other than `\r` are removed but not replayed, so some multi-line progress displays keep intermediate frames.
