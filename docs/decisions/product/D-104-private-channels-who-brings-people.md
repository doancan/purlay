# D-104. Private channels, and who brings people into a channel

#49 left creating a private channel undone, and nothing defined how anybody but its creator gets into
one: `join` is public only, and invitations and roles are #50 and #51. Decided by the owner on
2026-10-11: **any member of a channel may bring in somebody from the workspace.**

**1 · A channel is public unless created private.** `CreateChannelRequest.type` is `public` (the
default) or `private`; a direct message is never created this way. A private channel is seen by its
members only (D-34): its creator, and whoever a member brings in.

**2 · `POST /api/channels/:channelId/members { userId }`.** The caller must be *in* the channel —
seeing a public channel is not being in it (`403`; they can join it themselves first), and a private
channel is not seen at all from outside (`404`, the guard's). The person must be in the workspace with
an account that is not deleted (`404 USER_NOT_FOUND`, the same check a direct message makes). Somebody
already in it is `204` again and told nothing. The person brought in is told with `CHANNEL_ADDED` on
their own topic, after the commit, and their client subscribes.

**3 · A direct message stays between its two people** (`403`): its membership is its `dm_key` (I-5).

**Rejected: only the creator, or an admin, adds.** It makes the person who opened a channel its
gatekeeper for good and leans on roles that are #51's; any member is how a small team works, and #51
can narrow it with a role. **Rejected: deferring private channels to #50/#51.** The team needs a
channel a stranger to it cannot read before it moves in (S-1).

**Not yet:** leaving and removing (`POST …/leave`, Phase 1, with #51's roles), and the client's half
— the option when creating, and bringing people in — which is a `web` issue. *Leaving is D-123.* *Removing is D-172.*

**Amended 2026-10-13 (#520) — a private channel's name is not private.** Channel names are unique per
workspace across public and private channels (`idx_channels_unique_name`), so creating or renaming a
channel to a name a private channel holds answers `409 CHANNEL_NAME_TAKEN`, and a member outside it
learns that the name is taken. That is accepted: a name is how a channel is found and talked about,
not what is said in it; the members, the topic and every message stay the members' (`404` to anyone
else, D-34). **Rejected:** names unique per visibility — two `#design` channels in one sidebar, and a
migration, for a secret most teams do not keep; answering a free name with the same `409` — a lie
about a real collision.
