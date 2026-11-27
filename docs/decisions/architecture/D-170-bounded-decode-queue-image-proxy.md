# D-170. Decodes wait in a bounded line, and the image proxy holds at most one — amends D-109 §2

**Context.** At most two decodes ran at once per node (D-109 §2), but the line for them had no bound,
and the image proxy decoded after its fetch slot was released, so its own bound (four fetching,
sixteen waiting) did not cover decoding. A security review (2026-10-20) measured a 6300×6300 PNG of
128 KB taking about 287 ms to decode; two members at their costly-read budget (D-81) made an unrelated
small upload wait 17 s, and growing — one member could stall every upload on the node.

**Decided.**

1. **At most eight wait for a decode slot, per node.** At about 290 ms a decode at the pixel bound, the
   last of eight waits about a second and a quarter, as long as an upload should sit before it is told
   the server is busy. Past it a decode is refused at once, `429 RATE_LIMITED` — what the upload's own
   gate already answers, and what the composer says as "busy", with Retry. Never a 500.
2. **The proxy has a share of its own: one decode at a time, four waiting** — a round of its four
   fetches finishing together. Holding at most one of the node's two slots, a feed of pictures never
   keeps an upload waiting behind it; past its line, or the node's, the picture is not available now,
   the same `404 IMAGE_NOT_AVAILABLE` as any failure, with the reason in the log.
3. **Eight is above what today's callers can make wait at once** (four uploads per node, and the
   proxy's one), so the node's bound refuses only a caller that has lost its own gate.

Measured after (the review's own script, 2026-10-20): the same small upload decoded in 1 ms after ten
seconds of two members at budget.

**Rejected.** *Holding the proxy's fetch slot through its decode* — #110's review separated them on
purpose: a slow server would then hold a decode's turn as well, and the fetch line would wait for both.
*A longer node line* — a wait nobody sits through, and memory for every buffered image in it. *Ordering
uploads before proxy decodes in one line* — a priority queue to say what a share says with a second
`slots`.

**Cost of reversing:** two numbers in `attachments/images.ts`, the share in `images/proxy.ts`, and
their tests.
