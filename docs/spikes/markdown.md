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

## What the independent review found after this was written

A security review of the finished package, and its numbers measured here afterwards:

- **A lone `\r` hid a line from the nesting check**, which split on `\n` while the engine also ends
  a line at `\r`. `x\r` then `1. ` repeated to 16k took **2 284 ms**, and `x\r` then `> ` 218 ms.
  The check now splits as the engine does.
- **The autolink pass is quadratic in an unbroken run of `[-.+\w]`.** It is a regular expression
  over every text node, outside the tokenizer the other bounds measure. `.-` repeated to 16k took
  101 ms (4k: 7.3 ms, 8k: 25.5 ms, 16k: 100.9 ms). With the run limited to 1024 characters the worst
  measured was 8.4 ms, so the run is a fourth bound; inside code it is not counted, because the pass
  does not read code.
- **The mention parser missed a `~~~` fence.** A name inside one was a mention while the renderer
  would draw it as code. Not the engine's fault, but the same mistake as the first bound: a second
  set of rules for where code is.

## In a browser (#43, 2026-10-11)

The package bundled for the browser (`bun build --target=browser --minify`), each body read seven
times with `readMarkdown` and the median taken, in Playwright's browsers on an Apple-silicon laptop.
Every body at a bound was formatted and none threw; the stack held at the deepest tree allowed.

| Body | Chromium 156 | WebKit 27.2 |
|---|---|---|
| 32 containers on one line | 0.6 ms | 1.0 ms |
| 1000 delimiters, `*a` | 3.0 ms | 3.0 ms |
| 1000 delimiters, `[]` | 1.7 ms | 2.0 ms |
| 1000 delimiters, `_a` | 1.1 ms | 1.0 ms |
| an address-like run of 1024, `.-` | 0.6 ms | 1.0 ms |
| the deepest tree allowed: 48 nested list items | 7.4 ms | 10.0 ms |
| one fenced block, 16k | 4.2 ms | 6.0 ms |

The feed draws the same bodies end to end in `apps/web/e2e/hostile.e2e.ts`: at each bound
formatted, one past it as typed, no error in the page, and the page answering.

**Not measured: Firefox.** Playwright's Firefox (build 1555) would not start on this machine
(*Could not find profile folder*, with and without a sandbox), so its stack and timings are
unknown; the suite runs Chromium only. Which browsers are supported at all is not recorded
anywhere yet, and is its own decision.

**Observed: a long, formatted message passes the delimiter bound.** Prose with bold, code, a link
and emphasis every seventy characters, repeated to 16k, holds about 2 500 delimiters and is shown
as typed. Measured as 2.8 ms in Chromium — the bound is far from what the engine can take for prose
like this, and is set by the adversarial cases above.
