# D-119. A conversation has two edges: bubbles, and your own messages on the right — reversed by D-187

*Amended by D-321: a mention of you is a tint, no longer a fill (§5).*

**Amends D-100 §avatars-and-no-bubbles, D-110 §5 and `UX.md` §3.** The owner looked at the channel
drawn to D-118 and asked for it "not like Slack, left and right". The reference is the Superdesign
draft *Purlay Chat — Left/Right Conversation* (project *Purlay — Chat Screen*), branched from a faithful
reproduction of the current screen so that only the feed changed. D-100 rejected exactly this, for a
reason that was a trade-off, not a fact; the owner has made the other trade, and the code block is
designed for it below rather than the objection being forgotten.

**Decided.**

1. **Two edges.** Everyone else's messages are on the left, in a bubble on `surface-200`, with the
   avatar in its fixed column and the display name over the first bubble of a group. Your own are on
   the right, in a bubble on `accent-subtle`, with no avatar and no name. The time stays in the mono
   face: beside the name on the left, alone on the right.
2. **The avatar and the name belong to a group's *first* message**, not its last as the draft draws
   them. A last-message avatar moves every time somebody adds to the group, which changes the row
   above the reader — what `UX.md` §1 forbids. A grouped message's time waits, invisible until hover,
   where its avatar would be (left) or beside its bubble (right), so nothing reflows on hover either.
3. **A bubble is at most five sixths of the column** (`max-w-5/6`, a fraction rather than a token
   because it is a proportion of the feed, not a length), and as wide as its content below that.
   A code block keeps its own card inside the bubble: the box-in-a-box D-100 warned of is accepted,
   and kept light by the bubble having no border and no shadow of its own.
4. **Your own bubble is `accent-subtle`, not the draft's filled accent.** On the filled blue, the
   words a message can contain — a mention and a link in `accent-text`, an "edited" note in
   `ink-subtle`, a muted resolved root — fall below AA, and they are drawn by the content renderer
   rather than by the row, so a second ink set for them would be a second renderer. The tint carries
   the side; the edge carries it too, so colour is not the only signal.
5. **A mention of you marks the bubble** with a 2px `accent-text` edge instead of tinting the row, and
   still says so to a screen reader; a failed send marks it with the danger edge, as before.
   *Amended 2026-10-13 by the owner:* the edge read as a quotation, and a quotation was drawn with an
   edge too. A mention of you now fills **your own name** in the text (`accent` with `on-accent`), the
   bubble carries no edge, and the screen-reader words stay; a quotation is a recessed block on
   `surface-050` with a quote glyph and no edge. Rejected: tinting the whole bubble, which is what
   your own messages already wear (`accent-subtle`), so a mention in a DM to yourself would vanish.
6. **No hover tint.** The bubble is the shape; the row under the pointer only fades in its actions,
   which sit on the bubble's inner top corner — except your own message, where they sit on its
   outer corner: a short bubble is narrower than they are, and from the inner corner they ran past
   the feed's edge and scrolled the conversation sideways — first on a narrow window, and on a wide
   one too once Pin joined them (D-130) (`UX.md` §2). *Amended by D-150:* the actions are a bar on
   the row's own top edge, in the corner the message is not in, and only one row shows its bar.
7. **The channel's feed and composer are centred** in the column (amends D-110 §5). The other screens,
   which have one edge, still hang from the left. *Amended by D-177:* nothing is centred; the feed, the
   composer and every other screen fill the main area from its left edge.
8. **Square tails are not drawn.** The draft squares the corner nearest the speaker; radius is a
   whole-corner utility here (`rounded-2xl`), and a per-corner vocabulary for one shape is not worth a
   token family.

**Rejected.**

- *The filled accent bubble, with a second ink set for what sits on it.* The draft's look, but every
  inline style the renderer draws would need an on-accent twin, judged in `pairs.ts`, for one surface.
- *Avatar and time under the last bubble*, as drawn: see 2.
- *Keeping one edge and only adding bubbles.* Not what was asked: the request was for sides.

**Cost of reversing:** `message-row.tsx` and its tests, two centring classes, and this paragraph. No
contract, route, keyboard path or required state depends on which side a message is drawn on.
