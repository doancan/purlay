# D-160. Channels stay where they are; conversations come forward

**Context.** The sidebar ordered channels by their last message, newest first. Every message moved a
row: a mention put #deploys on top while the person was reaching for the row that had been there, and
with no sound and no banner (D-12) the reshuffle was the loudest signal the product made. UX §1.4 says
content never moves under the reader; the sidebar did exactly that. Found by two audits (2026-10-19).

**Decided.** Joined channels are listed **by name**, as starred ones already were (D-132): a channel is a
place, and a place stays put. What is unread is said by the row's weight and its badge, where it is.
**People and group conversations stay newest first**: a conversation with someone is a correspondence,
and the one being had is the one to find. `Alt+↑/↓` steps through unread in the sidebar's order, so it
now walks channels alphabetically.

**Rejected.** *A setting for the order* (Slack's "Sort by activity / alphabetically") — a preference
for what should simply be right is a second thing to maintain and test; reopen it if the team asks.
*Activity order frozen while the pointer is over the sidebar* — the list still jumps the moment the
pointer leaves, and the next look finds everything elsewhere.

**Cost of reversing:** one sort in `ordering.ts`.
