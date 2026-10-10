# handoff

Keeps one note per project folder, so the next session there can pick up where the last one left off. Notes are stored in `~/.claude/handoffs/`.

- **Full note:** `/handoff`, or the **[Write handoff note]** button above the prompt, has Claude write a note with what was done, where things stand, next steps, open questions and gotchas.
- **Automatic note (off by default):** with `/handoff auto on`, a session that did work saves a quick note at exit, with no model call. It has the last request, the files changed (by Edit, Write or Bash, through git), the open tasks, and the previous full note's sections. It has no next steps, because only Claude can say which are still to do. A session that only talked leaves an existing note alone.
- **Next session:** a new session in the folder gets the note as context for Claude.

Notes are written only for interactive sessions, not `-p` or SDK runs.

Requires [modbar](../modbar/) for the button.

## Commands

- `/handoff`: write a full note now.
- `/handoff show`: print the folder's note.
- `/handoff clear`: delete it.
- `/handoff auto on` and `/handoff auto off`: turn automatic notes on or off. The setting lasts across sessions and applies in every folder. `/handoff auto` shows it.

## Limits

- The note belongs to the folder the session started in, so a session started in a subfolder has its own note.
- Two sessions in the same folder share one note; the last to write it wins.
- Bash changes are found through git: outside a git repo they aren't listed.
