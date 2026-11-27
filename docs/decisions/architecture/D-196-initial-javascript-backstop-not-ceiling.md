# D-196. The initial JavaScript is a backstop, not a ceiling for features — amends D-49, `PRD.md` §5

**Context.** `PRD.md` §5 fixes the initial bundle at 250 KB gzipped and D-49 makes it a blocking gate, as the one
*deterministic* stand-in for what a person feels, which is time: cold load to an interactive channel (< 1.5 s), a
channel switch (< 100 ms), a keystroke painted (< 16 ms) — each recorded per commit and failed on a regression. Over
the product's first weeks the stand-in began to decide things the time never did. The overlays went into a deferred
chunk (D-163) when the bundle stood at 246.72 KB; the sidebar's arrangement (D-195) came to 250.20 KB and was
meant to lose a menu item, a tooltip and a sentence, and to have its menu made asynchronous, to finish at 249.95 KB.
A number that is rebuilt around by every feature is a ceiling on the product, and the product is what grows.

**Decision.**
1. **The cap is 400 KB gzipped.** The gate is unchanged in kind: `bun run budget:web` blocks, names the chunks and,
   with a source map, what grew in the largest. It is there so that an accident — a library imported whole, a locale
   that is no longer lazy, a grammar in the first chunk — fails loudly; the shape checks (one catalogue, no
   highlighter grammar, the initial modules in one file) stay as they are.
2. **A feature is put where it belongs, not where it fits.** Nothing is cut, left out or made asynchronous to pass
   the number. Deferring a thing nobody needs for the first screen is still a good choice — D-163's chunk stays as it
   was built — but it is made for **time**, judged by the time budgets and not by bytes.
3. **What a person feels keeps its own gates.** The cold-load, channel-switch and keystroke budgets, and the
   latency and idle-memory ones, are unchanged and are what is read when the first load seems slow.

**Rejected.**
- *No cap at all.* A rule needs a mechanism: with none, a 2 MB import is found by somebody's phone. The gate stays,
  at a size that the next few features do not touch.
- *A cap that rises with each feature.* The raising is the churn this removes; when 400 KB is near, that is a
  decision about what the first screen needs, taken with the time budgets in hand.

**Accepted.** The first load costs more bytes as the product grows. If that shows in the time budgets, the remedy is
chosen from them — what the first screen loads, what is cached, what is deferred — and not from a byte count.

**Reverses if** the time budgets are found not to see a cost that the bytes would have.
