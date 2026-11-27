# D-238. Every channel read at once: `Shift+Esc`, the palette and the workspace menu — builds on D-99 §4, D-147; closes #866

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** A person back from a week away opened thirty
channels one by one: the only bulk read was the inbox's (D-106), which reads notifications and leaves the read positions
where they were. Slack's `Shift+Esc` is the gesture people already know for this.

- **`PUT /api/workspaces/:workspaceId/read`**, no body, any member. Each channel of the workspace the caller is in and can
  see (`visibleChannelsIn`, so an archived channel's kept membership is not one) whose `unread_count` is above nothing is
  read to its newest message — a reply included, since replies count as unread too — by `markRead`, the read of one
  channel, in one transaction. The notifications it reads and the numbers it counts are therefore a read's, and nothing
  else can disagree with them.
- **A reply still waiting stays unread (D-147).** The position reads the feed; an answer whose notification waits is read
  in its thread or the inbox. So a channel can come back with its count and its badge unchanged. That is intended: the
  badge still means *something here needs you*. The answer lists every channel it considered, moved or not, so a client
  that cleared every badge first puts back exactly those.
- **One order for the locks.** The memberships are locked first, by channel id, as the inbox's read takes them, so two of
  these at once (two tabs, a double press), or one beside a read of one channel, take turns rather than deadlock.
- **Every device is told.** After the commit each channel answered is published as `CHANNEL_STATE` on the caller's own
  topic, moved or not, as a read of one channel is (H-API 4): a repeat repairs a device that missed the first.
- **Three doors to one command.** `Shift+Esc` anywhere in the signed-in page, taken in the capture phase because the
  panels, the feed, the editor and the composer read Escape without asking about Shift; inside a dialog or a menu the key
  is left to it, and a held key asks once. **Mark all channels read** in the palette and in the workspace menu, with the
  key beside it. The badges clear at once and are put back, where nothing newer was heard, with a toast when refused; a
  toast also says it was done, since a key that changes only badges would otherwise say nothing to a screen reader. Some
  browsers give `Shift+Esc` a meaning of their own (a task manager); where the browser keeps the key, the other two doors
  are the way.
- **Bounded by memberships, not paged.** The work is a read per channel with something unread in one workspace — tens,
  not thousands — inside one transaction, so the answer is a list of those channels and nothing more.

**Considered and rejected.** One statement that moves every position at once (the counting, the notifications and the
`state_version` rules of `markRead` written a second time, and two places to keep in step). Reading the waiting replies
too (D-147 is what keeps an unanswered answer from vanishing; the inbox's own **Mark all read** reads those). A confirmation
dialog (the gesture is meant to be quick; nothing is lost, every message stays and "mark unread" (D-212) puts any back).
A key with no meaning in any browser (people bring `Shift+Esc` with them; the palette and the menu cover the rest).

**Cost of reversing.** One route and `markAllRead`; the key, the palette row and the menu item.
