# D-210. What a paste becomes, a table from the row, numbered code, and text files read in place — builds on D-110, D-133, D-181, D-188, D-205

**Decided (the owner, 2026-10-30).** The owner asked for Markdown, CSV and styled code to be sent in the
right shape, and for the editor to match the best of its peers. The box stays a plain textarea of markdown
(D-110, D-181; WYSIWYG stays rejected, by the owner's choice): every change below is markdown the renderer
already draws, put where the caret is.

- **What a paste becomes** (`composer/paste.ts`, pure). Rows a spreadsheet copied (tabs) or a CSV (commas,
  or semicolons where the comma is the decimal mark; quoted cells per RFC 4180) become a GFM table — same
  width on every row, at least two columns and a header and a row, at most 200 rows, and comma cells short,
  so prose with commas stays prose. A comma or semicolon that ends or starts a line is punctuation, not a
  column (no header cell is blank), and words recognisably code are never a table — a paste of statements
  ending in `;` became a two-column table before this was said. Formatted text (`text/html`) keeps its emphasis, links (web and mail
  only), lists, headings (three levels, D-101), quotes, code and tables; an image is its alt text; Google
  Docs' all-wrapping `<b style="font-weight:normal">` is not bold; an editor's coloured code has nothing to
  keep and stays plain. The HTML is parsed into a document that is read, never shown, and a paste over
  200 kB of HTML is taken as its plain words. A long paste of code is a block named in its language when
  the language is clear (JSON by parsing, then what only that language looks like), so it is coloured and
  a diff is drawn as one (D-133).
- **One step back.** A table or formatting is a guess about what was meant: the toast offers **Paste as
  text**. `Cmd/Ctrl+Shift+V` pastes the words as they are. A code block keeps its Undo. Both follow D-205,
  which was decided alongside: the action finds the block it put in and puts the pasted words in its place,
  keeping what was written after it, and leaves a block that was itself edited; a newer paste's toast
  replaces the older one. Inside an open fence nothing is converted at all, and a paste that already is one
  fenced block is kept as supplied.
- **A block starts on its own line.** A long paste after words on the same line produced
  ```` before ``` ```` — not a fence, so the code ran into the paragraph and an empty block followed it.
  Blocks are now placed on lines of their own (`placeBlock`).
- **A table from the formatting row**: two columns and a row to fill in, its first heading selected.
- **Numbered code** from five lines on: each line beside its number, in a column not heard
  (`aria-hidden`) and not selected (`select-none`), so a hand selection copies the code alone; Copy still
  copies the raw text.
- **Text files read in place.** A CSV, Markdown or code file (by extension) up to 512 kB has **Preview**
  beside its download. It is read only when asked (`attachmentText`, with the session, cached for the
  page — an attachment never changes) and drawn through the renderer: a CSV's first fifty rows as a table
  and how many more, Markdown formatted, code coloured, the start of a long text with a note that the
  file goes on.

**Considered and rejected.** A WYSIWYG editor (the owner chose to stay with markdown); converting a paste
without a way back; previewing every file as the feed loads (a feed of files would be a feed of
downloads); rendering a file's HTML.

**Cost of reversing.** `paste.ts` and its call in the composer; one kind and one button; the numbered
lines in `code-block.tsx`; `attachment-preview.ts`, the preview in `attachments.tsx`, `Http.text` and
`attachmentText`; one size token and the strings.
