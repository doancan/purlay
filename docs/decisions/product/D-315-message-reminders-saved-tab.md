# D-315. Message reminders are a Saved tab and a More-menu item, drawn where chat runs — builds on D-128, D-150, D-248

*Amended by D-319: the spans in the menu say the clock time they come to.*

**Context.** The server can remind a person about a message (`PUT`/`DELETE /api/messages/:messageId/reminder`, `GET
/api/workspaces/:workspaceId/reminders`, `REMINDERS_UPDATED`, a `reminder` inbox notice when due), and the web
client had no way to ask. The native client already did, behind `capabilities.messageReminders`, which only the
public `GET /api/client` advertises.

**Decision.** *Remind me…* is a submenu of every message's More menu, after Pin: five presets in the viewer's own
time zone (*In 20 minutes*, *In 1 hour*, *In 3 hours*, *Tomorrow at 09:00*, *Next Monday at 09:00*) and *Pick date
and time…*, a lazily loaded dialog over the browser's `datetime-local` field, a minute to a year ahead, with what
will not do said under the field. A message that has a reminder reads *Reminder: <time>* with *Change…* and *Remove
reminder*, and carries the same words as a quiet line with *Edited* and *Pinned*. The wall clock is `Formatters`'
(`inputValue`, `instantOf`), so "09:00" is the viewer's and a clock change moves the hours, not the 09:00; a time a
change repeats is its first, one it skips is the moment after the gap; next Monday is never today. The list is one
cached read per workspace (`keys.reminders`), read again on `REMINDERS_UPDATED` and at every open of the user's
topic. A change is painted into that list at once after cancelling any read on its way, and a refusal puts back
only that message's entry, reads again and says which reminder failed, with Retry when the failure is transient.
The pending list is a fourth tab of Saved, *Reminders (n)*, in the address (`?state=reminders`), refreshed on
opening, on focus and by the frame. A due reminder needed nothing new: the inbox already drew `reminder` notices
with their wording, the message and a link to it, and an end-to-end test now holds that.

**Whether to draw it.** The browser does not ask `GET /api/client` (D-248, held by a test). Its `messageReminders`
flag is true exactly where chat runs (`API.md` §2) and `GET /api/me` already lists the modules, so the client draws
reminders where chat runs (`useRemindersAvailable`, `useRunsIfAny('chat')`) and nothing of them elsewhere. A client
that talks to a server older than itself is not a case the web has: the page is the server's own bundle.

**Rejected.**
- *Reminders in the Inbox.* The inbox is what already happened, read and marked; a pending reminder is a list the
  person keeps and edits, as saved messages are, and a second place for the same row in two states would need a
  second state machine. The due notice is in the inbox, where it belongs.
- *A client-side capability read of `GET /api/client`.* It spends the address's sign-in budget on every load
  (D-248) to learn a fact `me` already carries.
- *Adding `capabilities` to `GET /api/me`.* A server and contract change for the sake of one flag that cannot
  differ from the modules list; to be taken if a flag ever stops following a module.
- *Presets as a fixed offset from now for the mornings* (`+24 h`): it lands at 08:00 or 10:00 across a clock change.
- *An optimistic layer of intents beside the list, as Save has.* A reminder has no second state to hold apart
  (no *saved or not yet*): one list painted for one message and put back for that message is enough.
- *Native `Date` arithmetic in the viewer's zone.* The runtime's local zone is not the person's chosen one in a
  test or a desktop shell; the zone is an argument of `Formatters`.

**Cost of reversing.** Delete the feature's directory, the tab, the item and the mark: no schema, no server code,
no stored client state. Reminders already set stay on the server and keep arriving in the inbox. The one shared
change is `Formatters.inputValue`/`instantOf`, additive.
