# D-199. The feed is not virtualized: a channel out of view keeps its newest page, and the rest is measured — closes O-5, builds on D-197, D-49

**Context.** O-5 asked whether the feed must be virtualized, to be answered against the channel-switch budget
(`PRD.md` §5, < 100 ms) once the team had used Phase 1 for a week. D-197 took the week away: the measurement is taken
with a synthetic load and decided from it. The load is the worst the product draws, not an average one:
`apps/web/e2e/feed-scale.e2e.ts` seeds a channel of **2,000 messages through the real API** — eight in ten heavy
(a ten-line TypeScript block, a long markdown body with headings, lists, a quotation and links, two GitHub
pull-request and issue cards, a picture, a root with three replies), the newest fifty all heavy — and drives the real
production client in Chromium at 1440 px, as a person does: opens the channel, scrolls to the top until a page loads,
repeats, goes to another channel and comes back. A heavy row is about 83 elements. The window of fifty was never the
risk; **the unbounded part was what the feed keeps after a person scrolls back**: `useMessages` is an infinite query
with no page cap and the feed mounts every page it holds, and the pages stayed cached when the channel was left.

**What was measured** (one Chromium on the author's laptop, 20 switches away and back, 30 keys typed; the heap is the
collector's `JSHeapUsedSize` after a collection; elements are `document.getElementsByTagName('*')`):

| | window (50) | 500 loaded | 2,000 loaded |
|---|---|---|---|
| elements in the document | 3,419 | 42,282 | 166,444 |
| JavaScript heap, in view | 25 MB | 125 MB | 454 MB |
| keystroke in the composer to the next frame, p50 / p95 | 1.8 / 16.3 ms | 5.9 / 19.1 ms | 41.8 / 42.8 ms |
| older page: top reached to its rows drawn, p50 / p95 | — | 83 / 95 ms (9 pages) | 113 / 153 ms (39 pages) |
| **switch back to the channel, before the fix**, p50 / p95 | 47 / 52 ms | **409 / 437 ms** | **1,959 / 2,113 ms** |
| **switch back to the channel, after the fix**, p50 / p95 | 47 / 52 ms | 48 / 50 ms | 49 / 50 ms |

The window passes with a wide margin (the switch 52 ms of 100; a keystroke inside one frame). What did not is the way
back to a channel after a long read: everything that had been scrolled through was drawn again, at 0.8 ms a row —
four times the budget at five hundred messages and twenty times at two thousand. The mounted rows were not bounded.

**Decision.**
1. **The feed is not virtualized.** The window holds the budget; the one place it did not was a consequence of what
   was *kept*, not of how the rows are drawn, and keeping less is a smaller change than a virtual list over
   variable-height rows (the scroll-anchoring rules of `UX.md` §6 are exactly what such a list makes hard).
2. **A channel that is no longer on screen keeps its newest page and lets the older ones go**
   (`keepNewestPage` in `data/cache.ts`, called as the feed goes away). A channel opens at its newest messages or at
   its unread marker, so what was scrolled through is not what a person returns for; it is read again, a page at a
   time, if it is scrolled to. The newest page stays whole: it is what the switch draws from the cache, what a read
   position names, and what a message that arrives meanwhile is written into. The way back is the window's, 50 ms,
   whatever was read before.
3. **Held by a test and by the budget.** A unit test and the feed's test hold the trim (two mutations in
   `scripts/mutations/`). The browser test holds a *count*, which a shared runner cannot excuse — what a channel
   draws on return is at most two pages — and its times join the existing mechanism: `bun run budget:browser` reads
   the median switch back after 2,000 messages from the same `test-results/performance` files as the rest, and
   blocks on a regression against main's last runs (D-49). On a person's machine the switch back is held to 100 ms
   and the keystroke at 500 loaded to two frames. **The keystroke with 2,000 loaded is recorded, not gated:** it
   measures the state this decision accepts (a whole visit's worth mounted), a hosted runner measured it at 144 ms
   against 76 on the run before, and a gate on an accepted number fails for the runner and not for the code.

**Rejected.**
- *Virtualizing the list* (a windowed list with measured row heights). It would bound what is mounted whatever a
  person does, and it is the answer if the in-view cost below is ever felt. It was not chosen because the measured
  failure was not the list in view but the cache outliving it; a virtual list over rows that change height when an
  image decodes, a card arrives or a highlighter finishes puts a scroll-position bug in the one place the product
  promises none (`UX.md` §1, §6), to fix a cost a trim removes.
- *`maxPages` on the infinite query.* It drops pages from the end opposite the one being read — here the *newest* —
  and the feed would then need to read newer pages on the way down and to place arriving messages in a list that
  no longer reaches the present: the machinery of a message's window (D-149), moved onto the channel everyone reads.
- *CSS `content-visibility` on rows.* It saves layout and paint, not the elements, the fibers or the heap, and its
  estimated heights move the scroll position under a reader.
- *Trimming on return instead of on leaving.* It would do the work on the switch's own path.
- *Leaving it, because two thousand messages in one sitting is rare.* It is forty scrolls to the top, but the cost
  was paid by the *next* visit, to a channel the person had left, and it grows without bound.

**Accepted.** Inside one visit nothing is bounded: after forty scrolls to the top, 2,000 messages are mounted, the
heap is 454 MB and a keystroke takes 42 ms to its frame — over a frame, well under the 100 ms at which typing feels
late — and an older page takes 113 ms to draw. At 500 loaded these are 125 MB, 19 ms and 83 ms, no worse than the
window within the noise of the machine. This is recorded, not hidden: `feed-scale.e2e.ts` writes it on every run,
and the 2,000-message keystroke is watched for a regression by `budget:browser`. History a person wants far back is
better reached by search and by a message's link (D-149), which open at the message.

**Reverses if** the keystroke with the messages a reader typically has loaded (about 1,000) is found over 33 ms on a
machine a team member uses, or the heap of a long visit is reported as a tab that is killed or slow — then the
mounted rows are bounded in view as well, and virtualization is reopened with this table as its baseline; or if the
switch back, with the trim in place, is measured over 100 ms.
