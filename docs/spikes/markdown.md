# Spike — the markdown engine

**2026-10-11.** Run in a scratch directory with the candidates installed side by side, then again
inside `packages/markdown` as it was built. It closes O-6 and decides D-101: which packages read a
message's markdown, on which side, and what bounds their cost (#42, #43, D-57).

## Versions resolved

| | |
|---|---|
| Bun | 1.4.2 (macOS arm64) |
| `mdast-util-from-markdown` | 2.1.0, pulling `micromark` 4.0.3 |
| `micromark-extension-gfm-autolink-literal` / `-strikethrough` / `-table` / `-task-list-item` | 2.1.0 / 2.1.0 / 2.1.2 / 2.1.0 |
| `mdast-util-gfm-autolink-literal` / `-strikethrough` / `-table` / `-task-list-item` | 2.0.1 / 2.0.1 / 2.0.0 / 2.0.0 |
| `@types/mdast` | 4.0.4 |
| Compared, not chosen | `remark-parse` 11.0.0 + `remark-gfm` 4.0.1 + `unified` 11.0.5, `marked` 18.1.0, `markdown-it` 15.0.2 |
| Licences | MIT, every one |

## What each costs a browser

Each was bundled on its own (`bun build --minify --target=browser`, then `gzip -9`) behind one
`parse` function. The initial JavaScript was 165.39 KB of 250 KB when this was measured.

| Candidate | gzipped |
|---|---|
| `mdast-util-from-markdown` + `micromark-extension-gfm` + `mdast-util-gfm` (all of GFM) | 30.8 KB |
| the same, with only the four GFM extensions D-101 enables | **29.9 KB** |
| `unified` + `remark-parse` + `remark-gfm` | 39.8 KB |
| `markdown-it` | 39.8 KB |
| `marked` | 13.3 KB |

**`mdast-util-from-markdown` is the engine `remark-parse` wraps.** On eight probes — raw HTML, a
`javascript:` link, an image, a `www.` autolink, an emphasis edge case, strikethrough with a table,
a task list, a fence — its tree and remark's were identical once positions were stripped. One engine
on both sides therefore costs 30 KB, not remark's 40, and it removes the alignment risk D-36
accepted: there is no second parser to keep in step.

## None of them is safe by itself

Every candidate's tree carries an `html` node for `<img src=x onerror=…>`, a link whose url is
`javascript:alert(1)`, and an `image` with a third-party url. Safety is in what the tree becomes,
which is why `parse.ts` narrows it. micromark also lets constructs be switched off by name, and a
construct never recognised cannot be rendered wrongly:

| Off | Then |
|---|---|
| `htmlFlow`, `htmlText` | `<script>` is eight characters |
| `definition` | `[x][1]` with `[1]: javascript:…` is text, and so is every reference link |
| `labelStartImage` | an image is `!` followed by an ordinary link to its address — the image-as-link D-101 wants, for free |
| `codeIndented` | four spaces are indentation, not code |
| `setextUnderline` | `Title` over `===` is two lines of text |
| `characterReference` | `&lt;` is four characters |

`URL.canParse` without a base refuses `rel/path`, `//evil.example` and `#top`; `JaVa\tscript:` is not
a link at all (a tab is not allowed in a destination). Checked with the narrowed tree's tests.

## What the engine costs, and where it breaks

Sixteen thousand characters is the longest message (`MESSAGE_CONTENT_MAX`). Times are means of three
runs after a warm-up.

| Input, 16k | Full parse |
|---|---|
| realistic prose with bold, inline code and links | 6.8 ms |
| `*a` repeated | **308 ms**; ×12.3 from 4k to 16k — superlinear |
| `[` then `]` | 245 ms |
| `_a` | 57 ms |
| `1. ` repeated | **`RangeError: Maximum call stack size exceeded`** from depth 10 640, in remark too |
| `>` repeated | threw `RangeError` inside `unist-util-visit-parents` in one run and not in another |

A stack overflow that depends on the stack's state is not a bound anyone can test, and a browser's
stack is smaller than Bun's. Stored, such a body would break the channel for every reader.

**The bounds that hold, measured inside `packages/markdown`:**

- *Containers opened on one line* — quotation marks and list markers — at most 32. Checked first,
  in one linear pass, because the block reading itself spent 906 ms on 16k of `1. `.
- *Inline delimiters outside code* at most 1000. With 1000 of every kind at once the full parse
  took 20 ms; a table of 1000 pipes 6.4 ms.
- *Depth of the narrowed tree* at most 100, for what a line cannot show — emphasis inside emphasis.

Where code is comes from the engine: a **block reading** with every inline construct off. It is
cheap because the superlinear part is inline — 16k of `*a` read in 3.0 ms, a fenced 16k Python paste
in 1.5 ms — and with tables on (they are block structure, see below) the worst seen was 26 ms. A
body past a bound is shown as typed, not refused.

## What had to be loosened

**Nothing.** No lint rule was disabled and no type was widened: the engine's node types come from
`@types/mdast`, and both switches in `parse.ts` name every kind, including the ones that are never
recognised, because the lint rule refuses a `default` over a union.

## What surprised us

- **D-36's rejection had never been measured.** It turned down one parser shared between server and
  client because remark's tree would not fit the budget. The core it wraps is 29.9 KB.
- **The first bound was a copy of the grammar, and the agreement test broke it twice.** Fences were
  found by pattern so their contents would not be counted. A fuzz test comparing the pattern with the
  engine found that with `codeIndented` off the engine takes a fence at *any* indentation, then that
  no line pattern can follow a fence inside a list item. The copy was deleted, and the engine's own
  block reading was used instead — a third run found it needed the table extension to agree.
- **The fuzz test first tested one document.** Its generator was a linear congruential one in plain
  numbers, which lose their low bits past 2^53: it picked the same piece 19 348 times in 20 000. The
  test passed on code it could not have caught. It now uses 32-bit arithmetic and asserts that it
  generated more than 2500 distinct documents of 3000.
- **Two of the switches are each enough alone.** With raw HTML or definitions switched back on, the
  narrowing still turned their nodes into text, so a mutation removing a switch survived every test
  of the narrowed tree. The engine is now tested on its own (`engine.test.ts`) and both mutations are
  caught.

## Not measured

The browser's own stack depth (Chrome, Firefox, Safari), and parse time in a browser rather than
Bun. The client slice (#43) renders the narrowed tree and runs the same bounds, so its worst case is
the one above; the browser test that sends the deepest body allowed is part of that slice.
