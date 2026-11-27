# D-189. A heading in a message has a size — amends D-101 §3

**Amends D-101 §3.** D-101 drew every heading as bold text at the body's size, on the reasoning that a heading in a
conversation is not an outline. The owner wrote Markdown in the composer and found the `#` lines no different from
the paragraph under them (2026-10-26): a heading nobody can tell from bold text is a heading that does not work.

**Decided.** The narrowed tree keeps the heading's level, clamped to 1–3 (`level` on the `heading` block, additive: the
server's metadata, plain-text and prose readers ignore it). `#` is drawn at the `display` size, `##` at `title`, and
`###` to `######` at `heading` — the type scale has three sizes above the body, so a fourth level has none left to be.
All are semibold. They remain paragraphs, not heading elements: nothing in a message joins the page's outline, a
screen reader's heading list is the screen's and not the conversation's, and a message cannot take `h1` from the page.

**Rejected.** *Real `h1`–`h6` elements* — a hostile or careless `# x` in a feed of fifty would reorder the page's
structure for assistive technology. *Keeping the body size and relying on weight* — what the owner saw not working.

**Cost of reversing:** one field on one node, one branch in `render-content.tsx`, and their tests.
