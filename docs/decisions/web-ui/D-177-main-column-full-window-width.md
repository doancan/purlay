# D-177. The main column is the window's width, from its left edge

**Context.** D-175 widened the centred column to 1040px and rejected a fluid feed. Judging it live on a
1600px window, the owner still found it cramped and narrow: the feed, the composer, the inbox, the
open questions, search, saved and every Settings page sat in the middle of the main area with an empty
band on each side, while Slack, which the team uses daily, keeps its messages against the left edge
however wide or narrow the window is. The owner asked for exactly that and reversed D-175's rejection.

**Decided.**

1. The feed, the composer under it, the list screens (D-158) and the Settings pages (D-146) take the
   main area's full width, their content from its left edge. Nothing centres them; the gutter is the
   only margin — 24px on the feed, the composer, a list screen and the headers above them, 40px on a Settings page, and
   16px each below `size-narrow`.
2. A bubble is still at most five sixths of the feed (D-119; *dropped by D-187: a line is the feed's width*): the cap on a line moves with the window.
3. `size-feed-max` stays and bounds only what is drawn inside a column — an empty state's sentence, a
   GitHub card — not a column. `size-settings` bounds only the welcome screen, a focused one-time step.
4. A thread's line under a message — its status and **Show thread** — is as wide as what it says and
   sits beside the bubble, on the bubble's side; a full-width row would put the two a window apart.

**Amends** D-119 §7 (the centred feed and composer), D-175 (its rejected fluid feed is what this decides), D-146 §2 (the Settings column) and
D-158 (the list screens' centred column).

**Rejected: keeping a cap and left-aligning it.** On a wide window the empty band moves to the right
and the screen still looks unused. **Cost of reversing:** the containers' classes in six files.
