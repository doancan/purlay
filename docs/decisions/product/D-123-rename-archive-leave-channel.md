# D-123. Renaming, archiving and leaving a channel, and who may

*Amended by D-232: An archived channel can be brought back, by an owner or an admin, as it was.*

`API.md` §4 listed renaming, archiving and leaving as Phase 1 and unbuilt (D-104 left leaving for later).
The documents disagreed on who archives — `ARCHITECTURE.md` §7.4 gave it to every member beside
creating, `API.md` to an admin — and nothing said what the last member of a private channel leaving
does, or what a direct message answers. Served by #499; decided in the owner's standing instruction
to decide and proceed, and open to their reversal.

**Decided.**

1. **A member of the channel renames it and sets its topic** (`PATCH`). In it, not merely able to see
   it: the rule for bringing people in (D-104), and `403` otherwise. The name is the one a new channel
   takes, unique among the workspace's live channels ignoring case — `409 CHANNEL_NAME_TAKEN`, with the
   index the authority when two race (D-78). Asking for what is already there changes nothing and
   tells nobody. **A rename is on the audit trail** (`channel.renamed`, from and to — amends D-26's
   list): a name is what the whole workspace finds a channel by, and a changed one confuses everyone
   at once. A topic is a line somebody wrote and stays off the trail, as a message's words do.
2. **An owner or an admin archives** (`DELETE`); amends `ARCHITECTURE.md` §7.4. Creating hides
   nothing from anybody; archiving hides a channel's whole history from everyone in it, which is a
   workspace act. It is D-9's soft delete: the messages and the memberships stay, the name is free
   again (`idx_channels_unique_name` holds live channels only), and nobody sees the channel. Nothing
   in the product restores one in Phase 1. An admin who cannot see a private channel cannot archive
   it — `404`, because a role is not a way round visibility (D-34). On the trail as
   `channel.archived`, with the name it had, since the channel is no longer listed to find it by.
3. **Anybody in a channel leaves it**; somebody not in it is `204` again, told nothing. **The last
   member of a private channel is refused**, `409 LAST_CHANNEL_MEMBER`: only a member brings people
   into one (D-104), so with nobody left it could never be reached again. They bring somebody in
   first, or ask an admin to archive it. A public channel may be left empty — anybody can join it.
   *Taking somebody else out, and naming yourself, is D-172.*
4. **A direct message has none of these**: `404 CHANNEL_NOT_FOUND`, the answer `join` gives for a
   channel the endpoint does not serve. It has no name, and it *is* its two people (I-5).
5. **There is no default channel.** A workspace starts with none and an invitation joins none
   (D-115), so nothing needs protecting from being left or archived. A default channel, if one is
   ever made, decides that for itself. *Amended by D-174:* a workspace starts with `general`, and
   nothing marks or protects it — it is left and archived by these rules.
6. **Every open screen is told** (D-85). A rename is `CHANNEL_UPDATED` on the channel's topic — the
   name and topic whole, at the channel row's own count of its changes (`channels.state_version`,
   migration `0023`), so a late frame cannot undo a newer rename, as `CHANNEL_STATE` cannot. An
   archive is `ACCESS_REVOKED` on the channel's topic and a leave on the person's own, each with a
   `reason` (`archived`, `left`) so a person looking at the channel is told what happened rather than
   that it is not found. The field is optional, so a client built before it reads the frame as before.
   **Who hears it:** the sockets watching the channel — every socket that subscribed to it, which a
   `SUBSCRIBE` allows to anybody who can see it (a member, or anyone in the workspace for a public
   channel; `router.ts` checks visibility, not membership). Somebody who can see a public channel and
   has not opened it sees the change when their list is next read; a workspace topic for this is what
   D-85 rejected.
7. **Who is in a channel** is `GET /api/channels/:channelId/members`, for anybody who can see it.
   Not paged, as the workspace's own list is not: a channel's members are some of the workspace's,
   whose size D-25 bounds.
8. **A name is typed as it is said, and the client puts it in the rule's form as it is typed**
   (`UX.md` §2): lowercase, a letter's accents taken off and the dotless ı spelled, anything else one
   hyphen. The server's rule is unchanged — it still accepts any `name` the contract does — so an
   older client or a script is not refused; the form is the interface's, which is where people type.

**Rejected: archiving a private channel when its last member leaves.** It makes archiving a member's
act by another door, against 2. **Rejected: letting the last member go.** A conversation nobody can
read, join or archive through the product. **Rejected: `409` for a direct message.** A new code for a
request no client sends, where the existing refusal says the same. **Rejected: every member archives**,
as §7.4 had it: one person could take a channel's history away from everyone in it. **Rejected:
refusing a name typed with spaces or capitals**, as New channel did: it answered a person for typing
the way they speak, and the fix it asked for was always the same one the field can make.

**Cost of reversing:** a role check and a count in `features/chat/channels/settings.ts`, two rows of the
permission table, and this paragraph; no data changes shape.
