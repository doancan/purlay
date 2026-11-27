# D-181. The composer's formatting row, emoji picker and preview — extends D-110 (keys amended by D-188)

**Decided (the owner, 2026-10-23).** The owner called the message box "very weak" next to the competition's.
D-110 allowed three inserting buttons (bold, code block, mention); the renderer draws far more than that
(`packages/markdown/src/tree.ts`: bold, italic, strike, inline code, link, bulleted and numbered lists,
quote, code, tables). So the box now has **a formatting row above the text** with a button for every
construct the renderer draws (bold, italic, strike, link, bulleted list, numbered list, quote, inline code,
code block), **an emoji picker**, and **a preview toggle**. Each stays inside D-110's line: a button only
*inserts markdown* (`insertMarkdown`, pure and tested), the box stays a plain textarea, and what is sent is
the text. Nothing here is a second editor.

- **Keys do what the buttons do** (`formatKey`, one answer for both): `Mod+B`, `Mod+I`, `Mod+Shift+X` strike,
  `Mod+E` inline code, `Mod+Shift+U` link, `Mod+Shift+7` / `8` / `9` numbered list / bullets / quote,
  `Mod+Shift+P` preview. A button with a key names it in its tooltip; the shortcuts reference lists them.
- **`Shift+Enter` in a list or a quote carries it on**, and an empty item ends it (`continueList`); outside
  one it is the new line it always was. `Enter` still sends.
- **The emoji picker** is a grid on the menu primitive (four groups of sixteen: faces, hands and people,
  work, symbols), each tile named by its emoji, `←` `→` and `↑` `↓` moving through it. The emoji is text
  written at the caret. It is curated, not complete: a searchable list of thousands is a product of its
  own, and the operating system's emoji keyboard is one keystroke away for anyone who wants all of them.
- **The preview** draws the draft with the same `renderContent` a sent message uses and hides the textarea
  (it is not unmounted: the draft, the caret and the undo stack stay). It is a look, never a copy; Send
  works while it is open.
- A thread's box has the same row (D-164's parity).

**Writing-area refinement (Görkem, 2026-11-17).** Keep the plain-text/Markdown boundary while making
long-form writing readable: start with two lines and grow for actual wrapped lines, bounded by twelve
lines and 40% of the visual viewport. Preview is similarly bounded, exposes its toggle in words,
holds keyboard focus and disables insertion controls until the person returns to writing. The send
button shows its label where there is room, with the existing contextual hints below the text. Link insertion asks
for an address and display text in the existing dialog primitive, reuses `SafeHref`, escapes literal
labels and address parentheses, and replaces only the original selection. Cancelling or changing
channels cannot write anything into another draft. No new editor dependency, wire shape or storage.

The same refinement adds active formatting indicators. Source ranges come from the renderer's
bounded parser and are cached by draft text; selection changes only classify those ranges. Inline
content boundaries, the innermost list and conservative whole-selection containment decide state.
Pending empty wrappers are read with a virtual character so an inserted empty format can be shown
without treating escapes or URL characters as formatting. Link/table insertion remains an action.
Indicators change no draft, renderer behaviour, wire contract or formatting shortcut.



**Live editing amendment (Görkem, 2026-11-17).** Görkem explicitly reverses the textarea/preview UI
choice above: formatted text is directly editable by default. The **Markdown** toggle opens source
editing, with `aria-pressed` true in source mode; `Mod+Shift+P` switches the same two modes. The
choice is remembered on this browser. Both modes keep the same GFM draft, channel/thread isolation,
upload/paste policy and send contract. Viewing or switching modes does not rewrite an existing draft;
formatted edits serialize back to GFM. Marks, lists, quotes and code are native editing operations,
including stored marks at an empty caret, undo/redo, input rules and IME handling. Tables retain GFM's
single-line cells; Shift+Enter from a cell continues in a paragraph after the table.

ProseMirror's model, state, view, commands, history, keymap, input rules, lists and tables are justified
runtime dependencies: correct browser selection, composition and undo cannot be provided by a readonly
renderer or a hand-maintained contenteditable DOM. The editor imports through the existing bounded,
sanitized message grammar, never clipboard HTML. `diff` maps canonical editor offsets to an existing
draft's exact source, with a 20 ms bound and source-mode fallback. Over-limit drafts use source mode.
The editor loads in a separate chunk (81.68 KiB gzip in the measured build); the entry shell remains
256.18 KiB against its unchanged 258 KiB bound. Chat's entry measures 52.11 KiB; its bound explicitly
moves from 52 to 53 KiB for the two-mode controls and command/selection bridge. Link details and emoji
choices now load when opened. No HTML document, editor
JSON, new wire shape or data migration is introduced. Source-mode behavior tests explicitly select
source; separate browser tests cover the actual formatted default, selection, undo, composition and
accessibility.

**Editing completion (Görkem, 2026-11-17).** Görkem prioritizes four gaps: draft safety, clearing
formatting, existing-link editing/removal and leaving a code block. Draft lifecycle flushes now share
the timer's account/ownership checks and expose actual save/delete failures with a retry, without
blocking writing or sending. Clear targets selected inline text and its block styles (the current
paragraph for a caret), preserves code line boundaries and indentation, and is one native undo action.
Existing-link address changes retain the exact label and its styles; removal retains the label.
Code exit preserves the code and reuses or inserts a following paragraph. Source actions use the same
bounded editing model; ordinary source link insertion still uses its selection-preserving helper.
The existing SafeHref grammar renders empty-destination labels as text, so serialization uses them
to retain boundary whitespace/blank lines and explicitly unlinked URL labels without invisible
characters, HTML, character entities, or a new wire format. Empty formatted drafts cannot send,
and sending still trims ordinary trailing whitespace while keeping code and link-label contents.

**Originally considered and rejected (the live editing amendment supersedes the first item).** A WYSIWYG editor; a full emoji dataset
with search (cost out of proportion to what a team uses, and the system keyboard exists); a hidden toolbar
behind a "Aa" toggle (formatting that has to be discovered is not formatting people use); a preview in a
side panel (the width the thread panel needs).

**Cost of reversing.** `emoji-picker.tsx`, the row and the preview in `composer.tsx`, `insertMarkdown`,
`continueList` and `formatKey` in `composer-text.ts`, and the `MenuTiles` `grid` mode. No contract, route,
key or stored data: a draft is the same text it always was.
