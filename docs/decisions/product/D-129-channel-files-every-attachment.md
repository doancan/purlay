# D-129. A channel's files: every attachment of its messages, found by the channel — #485

**Context.** The Superdesign screens give a channel a Files list beside its conversation. An
attachment knew its message and its workspace (D-109), not its channel: listing a channel's files
meant walking every message of the channel to find the few that carry one.

**Decision.**
1. **An attachment carries its message's channel** (`attachments.channel_id`, migration 0027): NULL
   while unattached, set by the same statement that links it to its message, and held there by the
   database — linked and channelled together or neither, and the channel is the message's by a key to
   `messages (id, channel_id)`, as `mentions` is (I-1). Rows linked before it are backfilled.
2. **The list is the channel's, read through its context**: `GET /api/channels/:channelId/files`,
   refused as the channel's messages are (`404 CHANNEL_NOT_FOUND` for one the caller cannot see).
3. **What the channel shows, no more**: files of messages not deleted — a tombstone hides its files
   as it hides its words (D-109 §6), while a reply's file stays when its root is deleted, as the
   thread does (D-103 §7) — and never an unattached upload, which is its uploader's alone.
4. **Newest message first, then its files newest first**, keyset on the pair. The cursor is a file's
   id; one that is not a file of this channel's messages is `400`, never an empty page that looks
   like the end. A file whose message was deleted after the page was read is still a cursor, so
   paging on past a deletion goes on where it was.
5. **Each file says who shared it, when, and where**: its message's id, its thread's root, its sender
   and the message's time, so the list opens the file where it was said.
6. **A panel beside the conversation, not a screen of its own**: the header's Files control opens it
   in the thread's place, one panel at a time, and which is open belongs to the channel visit as a
   thread does (D-122). It is read when it opens and again when a frame says it changed — a message
   with files arriving, one deleted, or a resubscription — with no frame of its own. A read on its
   way is never cancelled for it: the list is read again once that read is in. Read again, it is read
   whole — each page loaded so far, one request a page — which a panel of a few pages can afford.

**Rejected.** *Joining through `messages` on every read* — correct, but an index cannot serve a
channel's attachments ordered by message without the channel on the attachment, and the list is read
each time the panel opens. *Keyset on the attachment's id alone* — an upload's id is the time it was
uploaded, not the time it was said, so the list would not be in the conversation's order. *A cursor
that does not exist reading as an empty page* — a list that ends early says nothing is wrong.
*A `FILES_UPDATED` frame* — every frame that changes the list already reaches the channel's sockets;
a second would say the same thing twice.

**Cost of reversing:** migration 0027's column, its two constraints and index, one route.
