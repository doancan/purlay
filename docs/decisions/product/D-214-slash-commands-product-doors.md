# D-214. Slash commands, as doors to what the product already does

**Decided (the owner, 2026-10-30).** Third of the core features the owner asked for (Slack's, Mattermost's
and Discord's slash commands).

- **The commands**: `/me`, `/shrug`, `/topic`, `/mute`, `/unmute`, `/star`, `/unstar`, `/invite @name`,
  `/leave`, `/deepwork 30m|1h|2h|tomorrow|off`, `/search`. Each runs through what already does it — the
  channel's edit, the header's level and star hooks, the Deep Work controls, the search address — so it
  paints, is refused and is put back exactly as its button, and the server checks what it always checked.
  No endpoint was added.
- **The list** opens on a `/` at the very start and narrows as letters are typed; Tab, or Enter until the
  command is whole, writes it out; Esc closes it. It is a listbox the box points at
  (`aria-activedescendant`), as the mentions list is.
- **Typos are not sent.** An unknown `/word` is far more often a slip than a message: it is refused under
  the box, naming the commands. `//` at the start sends a slash as words; a line with files attached is
  words, never a command.
- **`/me` and `/shrug` write markdown**, escaped so the words stay words: `/me` in italics with its
  underscores kept, `/shrug`'s backslash and underscores so the arm survives the renderer.

**Considered and rejected.** Server-side commands or an integration registry (an app platform is a
non-goal, PRD §6); sending an unknown command as text (a typo in a channel); commands with side effects
the product does not otherwise have.

**Cost of reversing.** `slash.ts`, `slash-run.ts`, the list in the composer, and the strings; two hooks
take a channel that may not be known yet.
