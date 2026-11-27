# D-127. Group conversations: a direct message of up to ten people, whose people are its identity — #486

**Context.** The Superdesign screens add a conversation with several people that is not a channel
(D-125 put it in Phase 2). D-6 made a direct message a sorted pair, D-104 §3 kept it between its
two people, and D-123 §4 gave it no rename, archive or leave.

**Decision.**
1. **A group is a direct message**, not a new channel type: `type = 'direct_message'`, no name, and
   `dm_key` the sorted ids of its people — two to ten (I-5, migration 0025). The same set of people,
   in any order, opens the same conversation; two people is the direct message D-6 described, and a
   note to self stays one id twice. `POST /api/workspaces/:id/conversations` takes the people
   besides the caller; `/dms` stays.
2. **At most ten people, the caller counted** (`CONVERSATION_PEOPLE_MAX`). Past that it is a
   channel, which has a name, a topic and settings a conversation does not.
3. **Its people never change.** No adding, no leaving (D-104 §3 and D-123 §4 kept for every direct
   message): more people is another conversation, started from this one's people, and the history
   stays where it was written. *Why not leave:* the set is the identity, so anybody in it reopening
   the set would bring a leaver back — silently, and able to read what was said after they left.
   Closing a conversation from one's own sidebar is a later choice, if the team asks for it. For
   the same reason a group is never filled in again: somebody removed from the workspace and let
   back in (D-111) is not returned to it by anybody reopening the set — only a conversation of two
   restores a missing membership, as before — and opening a group one is not in is `404`.
4. **Every message tells every other person in it**, as `direct_message`, push included (D-126):
   what is written in a conversation is written to its people. Weighed against D-12's quiet: a
   person mutes one conversation with notification level `none`, as for any channel.
5. **The contract is additive:** `Channel.peers` is the people besides the caller, in key order (the
   caller alone for a note to self, empty for a channel); `peer` stays for a conversation of two and
   is null for a group, so nothing reading `peer` can show a group as one person.

**Rejected.** *A `group` channel type* — an enum value cannot be used in the transaction that adds
it, and every direct-message rule would fork for no difference in behaviour. *A private channel
without a name* — a channel has settings, a topic and archive; a conversation has none of them.
*Adding people to a conversation in place* — the set would stop being the identity, and the unique
index with it.

**Cost of reversing:** migration 0025's check and function (groups already made would then fail the
two-id check, and would be deleted or turned into private channels first); the route and `peers`.
