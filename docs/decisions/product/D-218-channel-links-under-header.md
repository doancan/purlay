# D-218. A channel keeps its links at hand, under its header

*Amended by D-346: the bookmark chips scroll on their own while Add a bookmark stays in view, and a chip's × takes the place of its glyph.*

**Decided (the owner, 2026-10-31).** Eighth of the core features the owner asked for (Slack's channel
bookmarks, Teams' tabs).

- **`channel_bookmarks`** (migration 0062): a link and its name, per channel, in the channel's workspace by
  the composite key (I-4). The same address in a channel is one bookmark (`UNIQUE (channel_id, url)`): added
  again, the first stays, by whom and as named, and nothing is published — a double click or a retry is not
  a second chip. At most `BOOKMARKS_MAX` (20), counted under the channel's row lock (`FOR NO KEY UPDATE`, the
  lock a send's own write takes), so two members adding the last one cannot both get in. `added_by` outlives
  its person as null: the bookmark is the channel's. The workspace export carries them. *(Amended 2026-11-04, D-256: erasure
  soft-deletes the account, so the key's `SET NULL` never fires and `added_by` keeps naming the anonymised account.)*
- **Read by whoever can see the channel, changed by its members** — with the guest history/resharing boundary of D-300; otherwise the rule pins have (D-130): a visible
  non-member is `403 NOT_A_CHANNEL_MEMBER`; one in another channel, never there, or not a UUID is the one
  `404 BOOKMARK_NOT_FOUND` (D-34). Both suites cover the routes.
- **Only the web.** An address is `http:` or `https:` by the contract's pattern and parsed as a URL by the
  service, so nothing a browser would run (`javascript:`, `data:`) is ever kept; the client reads a bare
  domain as `https://`, as an address bar does, and names an unnamed bookmark after its site.
- **`BOOKMARKS_UPDATED`** on the channel's topic, after commit and only when something changed; it carries
  no bookmark and clients read the list again, as for pins. A removal changes nobody's sight of a channel,
  so it is not in the revocation table (D-85).
- **The bar** sits under the channel's header: chips that open in a new tab without the referrer, × on hover
  or focus for a member, *Add a bookmark* at the end. A removal is taken off at once, with **Undo** in the
  toast (the same address and name added back), and put back as the server has it if refused. For someone
  who may not change it and has nothing to read, there is no row at all.

**Considered and rejected.** Bookmarks as pinned messages (a link would need a message to live in, and
lose its place to retention); folders and reordering (a row of twenty does not need them yet); fetching a
title or icon from the site (an outbound request on every add, with its own SSRF guard — it belongs with
link previews, not here).

**Cost of reversing.** Migration 0062 (drop the table), the module and its three routes, one frame, the
bar and its strings.
