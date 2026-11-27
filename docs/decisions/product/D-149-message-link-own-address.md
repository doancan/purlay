# D-149. A link to a message: its own address, and the feed read around it

**Context.** Nothing in Purlay could be pointed at. The only deep link was a thread's (`?thread=`);
search, saved items and pins opened a channel at its bottom, so a message older than the first page
was a scroll and a guess away. Every chat tool a team compares this with has *Copy link*, and opening
one lands on the message.

**Decision.**
1. **The address is `?message=<id>` on the channel's own** (`router/routes.ts`, beside `?thread=`,
   read only when it is an id). One address for a root and a reply: a reply's link opens its root's
   thread, and the reply is the one marked there. *Copy link* writes it whole, with the page's
   origin. Search, saved items and **Go to message** in the pins panel go to it.
2. **The feed is read around the message, by one route built from the feed's own pages.**
   `GET /api/messages/:messageId/around` answers `MessageWindow`: the message, the root it lives
   under with `MESSAGE_WINDOW_SIDE` (25) roots either side, and two cursors that are the ones a feed
   already reads with — `olderCursor` as `before`, `newerCursor` as `after` (D-8). The server reads
   it as two keyset pages; nothing new orders a channel and nothing is offset. Who may read it is
   `requireMessageById`'s answer, so a message deleted, never sent or not the caller's to see is one
   `404 MESSAGE_NOT_FOUND`, and the endpoint is crossed on both axes like every other.
3. **On the client the window is a query of its own under the channel's key**
   (`['messages', channel, 'around', id]`), paged both ways. Everything that edits a channel's
   messages edits it too, because it is found by the channel's key. A message arriving is put in it
   **only once it reaches the present**: one put after the newest message of a window that stops
   short would sit above messages it has not read. Until then **Jump to recent** takes the reader to
   the channel without the link, as sending does, and nothing is marked read.
4. **Landing:** the message is brought into the middle of the view, focused through the feed's
   roving focus, and marked in the highlight tone (`warning-subtle`) for two seconds, fading by the
   hover token — which is zero under reduced motion, so no new motion token was needed. Newer pages
   read in below keep the reader where they are, without the pill: it is history, not news.
5. **A link nobody can follow says so in one sentence** over the channel, which opens as it is — a
   link pasted from a channel left, or a message deleted since, is ordinary and must not look like a
   failure of the product.

**Rejected.** *Reading back page by page from the newest until the message is in* — what `?thread=`
does: a link to a message from last year is dozens of requests and a wait, and the more a link is
worth (older), the worse it would work. *A cursor computed on the client one tick below the id, to
reuse `after`* — it leans on the id's byte layout and still needs a second request to learn a reply's
root. *An `around` parameter on the history route* — it would answer a different shape from the same
route, and a page carries one cursor. *Putting the window into the newest-first feed's cache* — a
feed with a hole in it is a feed every frame handler and the read position would have to understand.
*Highlighting with a new animation token* — the hover fade already says it, and costs nothing.

**Cost of reversing:** one route and its contract, the window query and the address; links already
pasted would open the channel at its bottom.
