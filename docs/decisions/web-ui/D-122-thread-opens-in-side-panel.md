# D-122. A thread opens in a panel beside the feed — closes #494

`PRD.md` §4.2 put threads **inline, underneath the parent, in the main feed**, with "no right-hand
drawer", and `UX.md` §1 and §4 built the interaction on it; D-110 and D-119 named the reference's
thread panel as the one thing not taken from it. On 2026-10-13 the owner decided otherwise, from the
Superdesign screen `frontend-feed.html`: **threads open in a side panel on the right.** This amends
`PRD.md` §4.2, `UX.md` §1, §4, §6 and §7, and the "not taken: the thread panel" of D-110 and D-119.
What the wedge *is* does not change: a thread is resolvable, resolved threads go quiet and stay
searchable, and the open questions are one screen away (D-98, D-99). Where it is read changes.

**Decided.**

1. **One thread at a time, in a panel on the right of the feed.** Its header says *Thread · #channel*
   with a close control; under it the root, its status and **Resolve / Reopen**, a rule labelled *N
   replies*, the replies as the feed draws them (two edges, D-119), and the reply box at the bottom.
   Opening another thread replaces it. Which thread is open belongs to the channel visit, as expansion
   did: a channel opened again opens with none, unless the address names one (`?thread=`).
2. **The root stays in the feed, marked.** Its line — *Open · 4 replies · last 12m ago* or *Resolved by
   alice* — is the way in; while its thread is in the panel the line is filled and says *Thread open*,
   and its `aria-expanded` and `aria-controls` point at the panel.
3. **Width.** On a wide window the panel is a fixed width, `size-thread` (380px, the design's) and the
   feed keeps the rest. Below the narrow line (`size-narrow`) it covers the conversation, header and
   composer included, and what it covers is hidden from a screen reader and from Tab — kept in place,
   so closing returns the reader to where they were. Nothing scrolls sideways at either width.
4. **Focus and keys.** The panel is a complementary region labelled by its heading. Opening it moves
   focus in — to the heading, or to the reply box when the person pressed Reply or `R` — and closing it,
   by `Esc` anywhere in it or the close control, puts focus back on the root's row in the feed. `T` on
   a focused root opens its thread in the panel; `R` and `⌘⇧R` work as before, on the row and inside
   the panel.
5. **Resolving from here closes the panel**, after the thread inside it folds with the product's one
   animation (UX §4.3); focus returns to the root. **Resolved by somebody else, it stays open** and only
   its status changes: nothing this person did asked for it, and a panel that vanishes under someone
   writing a reply moves content under the reader (UX §1). Inline, a remote resolution collapsed the
   thread; that rule is reversed.
6. **No "Also send to #channel".** The design draws the checkbox; the product has no such feature, so
   the panel has no such control. Adding one is a decision of its own.

**Rejected.**

- *Keeping threads inline.* It is what PRD §4.2 argued for — a drawer makes a discussion feel like a
  footnote — and what the code did until now. The owner's design is the reason it changes: in a feed of
  two-edged bubbles an expanded thread pushed the conversation down by its whole length, and the panel
  keeps both the channel and the thread on screen at once. The footnote risk is answered by keeping the
  root and its live status in the feed, and the open-questions view, rather than by where the replies
  are drawn.
- *Several threads open at once, or a panel per thread.* One panel is the design, and two would leave
  the feed a column too narrow to read.
- *A resizable panel.* `UX.md` §2 keeps resizable panes out of Phase 1: a saved layout is one more state
  to sync, for no benefit at this size.
- *Closing the panel when another device resolves the thread.* See 5.

**Cost of reversing:** the threads slice of the client (`features/threads`), the channel screen's
layout, `size-thread`, their tests and screenshots, and the documents named above. No contract, route,
schema or stored value depends on where a thread is drawn.
