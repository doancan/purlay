# D-217. Forwarding is a link, and a link to a message is a card only for whoever may read it

**Decided (the owner, 2026-10-30).** Sixth of the core features the owner asked for (Slack's "Share message",
Teams' forward).

- **`GET /api/messages/:messageId`** returns one message, found by the rule every route that names a message
  uses (`requireMessageById`): deleted, never sent, or in a channel the caller cannot see is the one
  `404 MESSAGE_NOT_FOUND` (D-34), with nothing of the message in it. Covered by the cross-tenant suite.
- **Forward…** sends, through the engine as the composer does, a message of the person's own: their note,
  then the original's link on a line of its own. Nothing new is stored — no "forwarded from" column, no copy
  of the words.
- **A link to a message of this workspace** (this origin, `/w/<slug>/c/<channel>?message=` or `?thread=`) is
  drawn as a card under the words — author, channel, time, the start of it — asked of that endpoint as the
  reader. Whoever may not see the original sees *This message is not available to you* and nothing else, so
  a private message forwarded into a public channel shares a link, never its words; checked end to end, in
  the page and in the network answer. At most three cards; a card is a decoration of a link already there.

**Considered and rejected.** Copying the words into the forward (it would leak a private channel to whoever
can read the destination, and go stale when the original is edited or deleted); a stored reference with a
schema of its own (a link and the visibility rule already say it).

**Cost of reversing.** One endpoint and its handler; `message-cards.tsx`, `forward-dialog.tsx`, the menu
item and the strings.
