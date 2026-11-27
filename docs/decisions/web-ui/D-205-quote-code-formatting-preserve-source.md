# D-205. Quote and code formatting preserve the source

**Context.** On 2026-10-29 the owner requested improvements to quoting and sharing code. Quote formatting removed list markers; fence counting disagreed with the renderer and could send unfinished code. Automatic paste formatting nested fences and its Undo replaced the entire draft.

**Decision.** Quote formatting adds or removes one outer quote, retaining lists, nested quotes and quoted blank lines. Selections ending at a line start exclude that next line. Code formatting uses a fence longer than those in the source, including indented fences, and retains trailing blank lines. Automatic formatting only applies to long pastes outside existing code; already fenced pasted code stays as supplied. Inserted fences occupy their own lines.

Undo removes the automatic formatting, keeping the pasted content and later surrounding edits. It only replaces an unchanged, unique insertion; otherwise it leaves the draft intact and explains that the block changed. A newer automatic paste replaces the previous Undo action; sending or leaving the composer dismisses it.

The shared Markdown engine reports whether the caret ends inside an open fenced block by observing its actual fence tokens (D-101). No second grammar decides Enter in the composer or message editor. The nesting guard also applies here; ordinary text without fence characters skips parsing. Locally measured median block-read times were 0.32 ms for a short snippet, 9.06 ms for 15,004 characters of code and 22.46 ms for 10,012 characters of table rows. Long language labels truncate before copy and wrap controls, including inside quotes on narrow screens; copying still uses the complete raw source.

**Rejected.** Restoring the pre-paste draft loses both pasted content and later edits. Counting delimiter lines cannot distinguish a shorter fence or invalid closing line. Adding a rich-text editor would replace the existing plain-text workflow to solve formatting bugs.

**Reversal.** Revert the client helpers and rendering classes; messages remain plain Markdown strings and require no data migration or contract change.
