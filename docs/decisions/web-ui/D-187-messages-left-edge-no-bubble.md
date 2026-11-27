# D-187. One edge again: every message hangs from the left, in no bubble — reverses D-119

*Amended by D-321: a mention of you is a tint, no longer a fill.*

**Reverses D-119 and amends D-150 §1, D-177 and `UX.md` §3, §4.1 and §4.2.** The owner's audit of the interface
(2026-10-26): messages are to sit on the left "like Slack", everywhere, direct messages included. D-119 had made the
opposite trade at the owner's request and recorded what it cost; this is the owner making the first trade again, and
the cost D-119 named — a bubble in a bubble around a code block — goes with it.

**Decided.**

1. **One edge.** A message by anyone, you included, is drawn as everyone else's was: the avatar in its fixed column,
   the display name and the time over the first message of a group, the words beside the avatar's column. The
   row has no `flex-row-reverse` and no `data-outgoing`; `data-own` marks it for a test and for nothing visual.
2. **No bubble.** The message body is a block without a fill, a radius or a border (`data-body`). The tint that
   told your side from theirs (`accent-subtle` against `surface-200`) is not needed with one side, and a fill under
   every message made a code block, a table and a quote three boxes deep. A failed send keeps its danger edge; a
   mention of you still fills your own `@name` (D-119 §5); a resolved thread's root is still muted.
3. **The bar of actions is at the row's top-right for every message** (the corner D-150 chose for other people's),
   and a thread's status line sits under the words from the left edge, as D-177 had it for theirs.
4. **The row is not made of one shape any more**, so there is no five-sixths cap: a line is as long as the feed.
   Long lines of prose are the feed's width, as in Slack; the composer and the feed already share it (D-177).

**Rejected.** *Keeping the bubbles and only moving yours to the left* — the two fills would then tell apart nothing
the name does not, and the box-in-a-box remains. *Keeping the right edge on a phone* — the second edge was a
feature of the whole screen, not of a width.

**Cost of reversing:** `message-row.tsx`, `message-actions.tsx`, `thread-summary.tsx`, their tests, `polish.e2e.ts`
and this paragraph; D-119's reasoning for the two edges is intact above for whoever wants it back. No contract,
route, keyboard path or required state depends on which side a message is drawn on.
