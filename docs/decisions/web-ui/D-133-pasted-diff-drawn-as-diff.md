# D-133. A pasted diff is drawn as a diff, for reading — #80

**Context.** People paste `git diff` output into a conversation to say "this is what changed". As a
code block it is a wall of `+` and `-`. D-125 put the diff viewer in Phase 2; review itself stays where
the code is (`PRD.md` §6).

**Decision.**
1. **A fenced block whose language is `diff` or `patch`** is drawn as a diff; every other language
   stays a code block. Nothing is guessed from the content: the fence says what it is.
2. **Read by a pure parser** into files (from `diff --git` and `---`/`+++`), hunks (from `@@`, with
   the numbers each line has on each side) and lines. A hunk ends where its `@@ -a,b +c,d @@` says,
   so a removed `-- comment` is a line and the next file's `---`/`+++` is a header; outside a hunk
   those two are headers only after `diff --git` or as a pair before a hunk. **Nothing pasted is
   lost**: git's notes (a rename, a binary file, `\ No newline at end of file`) and prose are rows of
   their own, a block of `+`/`-` lines with no headers is one hunk with no numbers, and a fence with
   nothing in it is a code block.
3. **Unified or split**, the reader's choice for that block, unified to begin with; split pairs each
   run of removals with the additions after it, context on both sides, a note across both. A narrow window has room for
   one column and is unified whatever was chosen.
4. **Never colour alone**: a line keeps its `+` or `-`, and a screen reader hears "added" or
   "removed" — words that are not selectable, so lines copied by hand are the lines. Each file is a
   table with named columns, its rows the lines.
5. **As a code block is**: the counts of what was added and removed, Copy for the raw text as sent,
   the clamp above twelve lines. No syntax highlighting inside it — the colour is the change.

**Rejected.** *Detecting a diff from its content* — a message about `--flags` or a list of `-` items
would be drawn as one. *Highlighting each line in its file's language* — a second colour on top of the
change, and a grammar per file for a paste. *Word-level changes inside a line* — worth it for review,
which this is not. *A remembered preference for split* — a setting for one block's view.

**Cost of reversing:** two files and a branch in the renderer.
