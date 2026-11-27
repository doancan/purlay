# D-172. Somebody can be taken out of a channel — amends D-104, D-123

**Context.** Only leaving existed (D-123); D-104 left *removing* for later. Somebody brought into a
private channel by mistake could only leave on their own, or be removed from the whole workspace
(D-111). An audit before a team's daily use found it, and the owner asked for it (2026-10-20). How it
is built was decided under their standing instruction to decide and proceed, and is open to their
reversal.

**Decided.**

1. **`DELETE /api/channels/:channelId/members/:userId`**, the path a person's membership has, beside
   `POST …/members` that brings them in. `204`, and the person is out of the channel; **their messages
   stay** (D-9), by their name.
2. **Who may.** An **owner or an admin**, from any channel they can see — a role is not a way round
   visibility, so a private channel they are not in is the stranger's `404` (D-34), as archiving is
   (D-123 §2). As for the workspace, **an owner is an owner's to take out** (D-111 §1): an admin is
   `403` for one. A **member of a private channel** takes out another member of it whose workspace
   role is `member`: whoever is in a private channel brings people in (D-104), so taking out somebody
   brought in by mistake is theirs too, and waiting for an admin would leave the mistake in the room.
   They do not take out an owner or an admin — those run the workspace, and a member removing them is
   a demotion by another door. **In a public channel a member takes out nobody** (`403`): anybody can
   join it again, so it would only be a quarrel with a button.
3. **Yourself is leaving.** Naming yourself is `POST …/leave` by another door — the same last-member
   refusal, the same `reason: "left"`, nothing on the trail. A refusal would teach a client a second way
   to say *leave* is wrong; a removal of oneself would put leaving on the audit trail.
4. **Never in a direct message or a group** (D-127): a conversation's people are its identity and
   never change. The stranger's `404 CHANNEL_NOT_FOUND`, as leaving and renaming answer one (D-123 §4).
5. **The last member of a private channel stays** (`409 LAST_CHANNEL_MEMBER`), the rule leaving keeps
   (D-123 §3): with nobody in it, nobody could reach it again. Somebody who removes must be able to
   see it, so they are in it and this is reached only by a race, but it is checked under the lock.
6. **The same discipline as a workspace's removal** (`modules/workspaces/members.ts`): the workspace
   row first (shared, so a role change waits and the roles read are the ones that hold at the commit,
   D-111 §2), then the person's membership, then the channel row (#669's order); the roles — the
   caller's too — are read inside the transaction. Somebody not in the workspace is
   `404 USER_NOT_FOUND`; somebody not in the channel is `204` again and tells nobody.
7. **Every open screen of theirs is told** (D-85): their sockets are sent `ACCESS_REVOKED` on their
   own topic with a new reason, **`removed`**, so a person reading the channel is told what happened
   — *You were removed from this channel* — rather than that it is not there. Their sidebar loses it at
   once; a public one comes back to their list as one not joined. What they are told about it stops
   with the membership: nothing from a private channel, and from a public one only what reaches anybody
   not in it — a mention of their name, a thread they follow (D-29, D-161).
8. **On the audit trail** as `channel.member_removed`, the person as its target and the channel by id
   only, so the audit page names it to a reader who can see it and says "a channel" to anybody else —
   the rule feeds' entries keep (#691).
9. **Offered in the channel's details** (D-154, *Members*), on each row the person may remove and not
   their own: Remove asks in the row first, as Settings → Members does, the row goes at once, and a
   refusal puts it back and says why. **Not in the sidebar's menu** (D-165): that menu is the person's
   own relationship to the channel, and taking somebody else out is not one.

**Rejected.** *Any member removes anybody, as D-104 lets any member add* — in a public channel it is a
quarrel nobody can settle, and in a private one it lets a member take out the people who run the
workspace. *Owners and admins only* — the people who bring somebody into a private channel are the ones
who notice the mistake. *Refusing to remove oneself* — a second answer for a request whose outcome is
exactly leaving. *Telling the rest of the channel* — nobody's screen depends on it; the members list is
read when it is opened.

**Cost of reversing:** `removeChannelMember` in `features/chat/channels/settings.ts`, its route, a reason in
the contract, a row on the audit page and the details' Remove; no table changes shape.
