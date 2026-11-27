# D-188. Writing and reading a message: Enter by context, code that is seen, and one grammar for an edge

**Amends D-110, D-181 and `UX.md` §3, §5.** The owner's audit of the interface (2026-10-26) asked for the
composer's code controls to be checked, Markdown to read properly, the send keys to be tested, code to be
formatted by its type, and the borders to stop disagreeing.

**Decided.**

1. **Enter is one function, `enterAction`, and the composer and the editor of a sent message both ask it.** Shift+Enter
   is a new line (and carries a list or a quote on); Ctrl/Meta+Enter sends from anywhere; a plain Enter sends, except
   inside a code fence that is still open, where it is a new line. The editor of a sent message did not know the fence:
   Enter inside a block of code saved the half-edited message. It now also takes the formatting keys and Shift+Enter's
   list continuation. **On a device that is only touch** (`(pointer: coarse) and (hover: none)`) a plain Enter is a new
   line, since a phone's keyboard has no Shift+Enter and the composer had no way to write a second line there; Send is
   the button, and Ctrl/Meta+Enter still sends from an attached keyboard. While the caret is inside an open fence the hint under the box names the key that sends
   (`Ctrl+Enter` / `⌘↵`) rather than saying Enter does, and so does the editor's, which names the key that saves; the
   composition (IME) rule is one hook, `composition.ts`, for both boxes — the editor had none, and an IME's confirming
   Enter saved a half-composed edit.
2. **A code block has a key**: Ctrl/Meta+Alt+Shift+C, read by the key's position (Alt turns C into `ç` on a Mac), shown
   in the tooltip of the button. Plain Ctrl+Shift+C is the browser's inspector and a page cannot have it. **A backtick
   typed over a selection wraps it** in inline code instead of replacing it; Ctrl+Alt is let through, as it is AltGr on
   Windows layouts that type a backtick. The same care applies to the code chord: a chord the browser reports as `AltGraph`
   is a letter on layouts such as the Polish programmer's, and is left to type it.
3. **A fence names its language, and the language is coloured.** The grammars grew from 14 to 33 (Java, C, C++, C#,
   PHP, Ruby, Kotlin, Swift, Dockerfile, TOML, XML, GraphQL, SCSS, Lua, INI, PowerShell, Makefile, nginx, protobuf, and their
   usual spellings: `c++`, `c#`, `rb`, `kt`, `gql`, `ps1`), each still a chunk loaded on first use, so the initial
   bundle is unchanged. A language that is not known stays plain, as before. The colour was there but could not be seen:
   `syntax-keyword` was `#2c2c54` in the light theme and `#c4c4ee` in the dark — the ink, within a shade — so a keyword
   looked like any other word. It is now a violet (`#6d28d9` / `#c4a7ff`), passing the same contrast pairs.
4. **One grammar for an edge**, held by `styles.test.ts`. At rest an edge is `border-subtle` (a card, a divider) or
   `border-strong` (a control the line is the only cue for); **hover changes the fill, never the line**; selected is
   `accent`; a fault is `danger`; focus is the one ring. The outliers were a reaction chip and a checkbox whose edge
   went to the dark ink on hover, the jump field's edge going to the dark navigation ink, and the channel details tabs
   underlining the selected tab in ink (black) where every other selection is the accent. Two hover edges remain, named
   in the test: the primary button's (`accent` to `accent-hover`, the same hue a step on) and the avatar ring in the
   sidebar, which is the sidebar's own ground.

**Rejected.** *A second key for "send" inside a fence only* — Ctrl+Enter already sends everywhere; the hint now says so.
*Highlighting with no language by guessing it* — a guess that is sometimes wrong colours a message wrongly, and the
language costs the writer three characters.

**Cost of reversing:** `enterAction`, `typedWrap` and the `formatKey` chord are in `composer-text.ts` with their tests;
the grammars are lines in `highlight.ts`; the colours are two values in `tokens.json`; the border test is one block.
