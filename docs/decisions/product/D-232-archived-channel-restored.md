# D-232. An archived channel can be brought back, by an owner or an admin, as it was — amends D-123; closes #846

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-123 made archiving a soft delete that
keeps a channel's messages and memberships, but nothing could undo it: an archive by mistake — the common case —
left the history unreachable except through an export. The data was always there; only the way back was missing.

- **Who.** An owner or an admin, as archiving is. A member is `403`.
- **What they see.** `GET /api/workspaces/:workspaceId/archived-channels` answers name, type and when, the most
  recently archived first, at most `ARCHIVED_CHANNELS_MAX`: every public channel, and a private one only to a member
  of it. A private channel stays unseen by those outside it, archived or not (D-104); to them, restoring it is
  `404`, as any channel they cannot see.
- **What it does.** `POST /api/channels/:channelId/restore` clears `deleted_at` under the row's lock: messages,
  memberships, settings and feeds return as they were. Each member is sent `CHANNELS_UPDATED`, so it rejoins their
  sidebars without a reload. It is on the trail as `channel.restored`, with the name.
- **A name taken since is refused, not changed.** Archiving frees the name (`idx_channels_unique_name` holds live
  channels), so another channel may hold it now; that is `409 CHANNEL_NAME_TAKEN`, and the admin renames one of the
  two first. A restore that picked a new name on its own would bring back a channel nobody recognises.
- **Where.** A card on General, the page owners and admins already have, rather than a page of its own.

**Considered and rejected.** Restore under a new name in the same request (a second form for a rare case; renaming
the other channel first is one step). Listing archived private channels to every admin (it would tell them names
D-104 keeps from them; the audit trail's names are D-104's own, older trade). A time limit after which an archive
cannot be restored (retention already decides what an archived channel keeps).

**Cost of reversing.** Remove the two routes and the card; archived channels stay archived.
