# D-216. All unreads: what is new, everywhere, read only as far as it was seen

*Amended by D-282: Catch-up reads only the displayed range, with a join scope and independent thread receipts.*

**Decided (the owner, 2026-10-30).** Fifth of the core features the owner asked for (Slack's "Unreads").

- **One screen** (`/w/:slug/unreads`), reached from a row at the head of the sidebar's lists — there only
  while a channel waits, with no count of its own (D-110) — and from the palette.
- **Which channels**: joined, unread, and not set to tell nothing (D-107: a quiet channel is not asking to
  be caught up on), in the sidebar's order. The state is the channels' cache, so reading one anywhere
  takes it off this screen.
- **What is shown**: each channel's roots after its read position, oldest first — the feed's own `after`
  page (D-8), twenty at a time, with "More in #channel" when more waits; a channel never read shows its
  newest page. Mentions are drawn as the feed draws them.
- **Mark read reads what was shown**, up to its newest root, and no further: nothing the person did not see
  is marked read. Found end to end: a channel whose unread are replies — unread by D-147 although the feed
  is read past them — showed a count and nothing under it; it now says the replies wait in their threads,
  and opens the channel, since a reply is read in its thread.
- **No endpoint was added.**

**Considered and rejected.** Reading the whole channel from here (it would mark read what was not shown);
listing muted channels; a numeric badge on the row (D-110).

**Cost of reversing.** The screen, its row and the rule in `waiting.ts`, a route, a palette entry, a cache
key and the strings.
