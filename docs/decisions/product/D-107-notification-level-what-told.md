# D-107. What each notification level is told

*Amended by D-329: A level may be chosen for a while, and the person's other tabs are told of a change.*

`notification_level` has been in the schema since the start (`'mentions'` by default), and delivery
honoured `none`; nothing said what `all` meant, and no endpoint set any of them. Served by #52; decided
in the owner's standing instruction to decide and proceed, and open to their reversal.

**1 · Three levels, per membership.** `mentions` (the default, because quiet is the product): what is
addressed to the person — named, a direct message, an answer in a thread they started or joined (D-29).
`none`: nothing at all, participation included; the messages are still unread, and the channel is
still bold, but the badge never moves. `all`: every message by somebody else, as a direct message is.

**2 · `all` is a notification of its own kind, the weakest.** `channel_message` (migration `0017`): the
inbox says why a person was told, and "somebody wrote in a channel you follow closely" is not a
mention. A stronger reason for the same message — a mention — is still the one row they get (D-99 §1),
and it is counted on the badge like the others: one list, `NEEDS_YOU`, read by the send that counts,
the read that recounts and the delete that takes back, so the three cannot disagree.

**3 · `PUT /api/channels/:channelId/notification-level { level }`, the member's own row.** A channel the
person can see and has not joined is the stranger's `404`, the read position's rule (D-99 §4): there is
no membership to set. Not retroactive: what was told stays told, and a badge comes down by reading, not
by muting. The channel carries the caller's level as `notificationLevel`, null for a non-member.

**Rejected: `all` as `direct_message` notifications.** The inbox would say "wrote to you" for a message
written to a channel. **Rejected: lowering the badge when a channel is muted.** It would make muting a
way to mark things read without reading them, and the two would disagree the next time a read recounts.
**Not yet:** telling the person's other devices that the level changed — they see it the next time
they read the channel list.
