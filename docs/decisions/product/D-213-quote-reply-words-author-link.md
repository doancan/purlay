# D-213. Quote reply: the words, whose they are and a link back — never a mention

**Decided (the owner, 2026-10-30).** Second of the core features the owner asked for (Teams' and Discord's
reply with a quote).

- **More → Quote reply**, for a member: the part of the message the person had selected — read as the
  menu opens, before choosing an item can move it — or all of it, into the composer it answers in: a
  reply's thread, a root's channel. Every line behind `> `, then a line with the author's name and a
  link to the message, then the
  caret, focused once the menu has closed (`onCloseAutoFocus`; while open, or closing, it holds focus).
- **Named, not mentioned.** The author is their display name, never `@username`: quoting somebody is not
  calling them (D-12), and the link is how the reader finds the original.
- **Bounded** to its first thousand characters, ended at a line: a quote points at the original.
- **No new server surface**: the quote is markdown, sent as any message is. A composer is reached by its
  key (`composerKey`), so the message's menu needs no handle on whichever composer is open; a reply whose
  thread is closed has none, and a toast says to open it.

**Considered and rejected.** A structured "reply to" reference stored with the message (a schema and a
contract for what a markdown quote and a link already say); mentioning the author (a notification for
being quoted).

**Cost of reversing.** `quote.ts`, the composer's inbox, the menu item.
