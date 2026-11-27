# D-259. The composer reads what a paste is by its shape, and offers a file for what is too long — builds on D-188, D-205, D-210

**Context.** D-205 and D-210 turned long code into a block and rows and formatted text into tables and
Markdown, but four ordinary pastes went wrong. A spreadsheet's range was uploaded as its picture, because any
file on the clipboard ended the reading of its words. A Markdown note over twelve lines became a `yaml` code
block: a bullet list is also a YAML list. A command on one line, or five lines of JSON, stayed plain words. A
very long text was a message that could not be sent. And `languageOf`'s CSS test backtracked cubically: a
single line of 4,000 characters took 3 s to read and 16,000 would have held the box for minutes, against
CONTRIBUTING §3's linear scans.

**Decision.** Pure recognisers in `paste-shapes.ts`, decided in `paste.ts`, applied by `onPaste`:
1. **Words win over a made-up picture.** Files whose name is the clipboard's own (`image.png`) are dropped
   when there are words; a file with its own name, or whose name is the words (the Finder's copy), is kept. A
   file listed only under `items` is read. A clipboard picture is named for its second.
2. **One line of code** is inline code only when the whole line is a known program with a flag, a path or no
   sentence word after it, a source path with its line, `NAME=value`, or a whole statement. **A few lines** are
   fenced only in a language that is certain; YAML never is, JS needs a line that is code; a stack trace is a
   block with no language.
3. **Markdown is Markdown**: two kinds of its signs and no code language (a YAML verdict on bullets without a
   `key: value` line is withdrawn) leave it as written.
4. **A URL over selected words** is their link; **a column of numbers** gets `---:`; a cell's words and its
   leading zeros are never changed.
5. **A file is offered, never made**: from 500 lines or 16,000 characters, or 200 table rows, a row under the box
   asks, in place of a toast, until answered. Accepting uploads `pasted-YYYYMMDD-HHMM.md|txt|<language>|csv`
   and removes the words; a table's file is a CSV with its cells quoted.
6. **Every recogniser is tested on hostile input** of the message limit's size, each under a second.
7. **A Markdown block has two views, and a Markdown file opens on its preview.** A fence named `md`/`markdown` has a
   Source/Preview switch (the preview is the message renderer, so HTML stays words; Copy is always the source);
   a `.md` file's preview is that block, opened on Preview. The preview region is `relative`: the renderer draws
   an announcement for every external link out of the flow, and one whose containing block is outside a clipping
   box escapes it — a note of 120 links made the feed 8,900 px taller and scrolled the person away (found in a
   browser, then again in the browser test that was written for it).
8. **Task lists and plain lists.** A Task list button and `- [ ] ` continuation (the renderer already drew boxes);
   a list pasted as plain words (`•`, `☐`/`☑`, counting `1)`) is a Markdown list. A dash is not read: in Turkish
   prose it opens a speaker's line.
9. **The sidebar's rows have a gap** (`gap-1`): rows are rounded and were flush, so a hover and the current row
   touched.
10. **The image viewer** opens with a fade, draws the picture on a shadow with rounded corners and the position
   in a pill; its thumbnail shows a zoom mark on hover and focus, and always on a touch screen.

**Rejected.** *Making the file at once with an Undo* (a CEO and a developer asked, independently, never to be
surprised by a message becoming a file; a phone's toast is gone before it can be answered). *Inline code for any
line with a keyword* (`Please export the report (final);` is a sentence). *Treating all bullets as YAML or all
as Markdown* (both occur). *Enlarging a picture in the viewer* (D-159's fit stays).

**Cost of reversing.** One module and its tests, the row, and two catalogue entries; nothing is stored.
