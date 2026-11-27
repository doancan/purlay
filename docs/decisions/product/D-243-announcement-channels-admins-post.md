# D-243. Announcement channels: only owners and admins post in the feed, everybody replies — builds on D-111, D-123, D-156; closes #871

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** An `#announcements` channel fills with chatter:
anybody in it may start a conversation in its feed, and what was announced scrolls away under the answers. A channel may
now be marked so that **only the workspace's owners and admins post a root** there, while **everybody in it still replies
in a thread**: the announcement stays in the feed, the conversation about it under it (D-122).

- **One column, one rule** (0072): `channels.only_admins_post`, false for every channel before it, held off a direct
  message by `channels_only_admins_post_not_dm`. No per-channel list of posters and no new role: the workspace's roles
  (D-22) are who may speak for the team already.
- **Said through the channel's settings**, `PATCH /api/channels/:channelId` with `onlyAdminsPost`, beside the name and the
  topic (D-123): only an owner or an admin among the channel's members changes it (`403 FORBIDDEN` for a member, the role
  read in the transaction, so a demotion that committed first is the answer); the same value again changes nothing and
  tells nobody, whoever asks. A direct message or a group has none — the stranger's `404`, as for a rename. It is on the
  trail as `channel.posting_changed` (`from`/`to` as `everyone` or `admins`), named only to a reader who can see the
  channel (#691), and the room hears it in `CHANNEL_UPDATED`, at the channel row's version, with the name and the topic.
- **Refused where every message is written.** `sendMessage` — the one write behind the socket's `MESSAGE_SEND` and
  `POST /api/channels/:channelId/messages` (`ARCHITECTURE.md` §5.1) — refuses a root from somebody whose workspace role is
  `member` with `403 ONLY_ADMINS_POST`, a code of its own so a client says *reply in a thread* rather than *not allowed*,
  before anything is written. A reply never reads the rule. Editing one's own message is not a new message and is not held
  to it (D-103). A GitHub feed's event (D-134) is the channel's own integration, written by its own path, and keeps
  posting. Nothing else writes a message today: an incident's timeline and write-up are the incident's (D-137), not the
  feed's, and there are no slash commands.
- **A retry is answered.** A member's resend of a root they wrote before the channel became an announcement channel is
  answered with that message, as any retry is (D-8, D-33); only a new one is refused.
- **A demotion is the next send's answer.** The role is read in the send's transaction under the workspace row's
  `KEY SHARE` lock — the one the message's foreign key takes anyway, taken before the role is read — which a role
  change's `FOR UPDATE` waits on and waits for (D-111 §2). A demotion in flight makes the send wait and then refuses it; a
  send in flight makes the demotion wait and is kept, since it was made by an admin. A change of the rule itself racing a
  send is decided by which the send read: one that read the rule before it was turned on lands, as if it had come a
  moment earlier.
- **The screen says it before the server has to.** For a member who is not an owner or an admin the channel's composer is
  replaced by a sentence saying who posts here and that a thread is still theirs; the thread's composer stays. The header
  carries a megaphone, named for a screen reader, for everybody. Owners and admins who are in the channel find the box in
  the channel's details, saved as it is ticked. A client whose role is stale meets the server's `ONLY_ADMINS_POST` as a
  failed send with that sentence.

**Consequences.** A root in any channel costs one more read, of the channel's row by its primary key; in an announcement
channel, one more lock the insert would take anyway and a read of the sender's role. **An open tab built before this**
receives `CHANNEL_UPDATED` with a field its closed shape does not have, reads it as malformed and reconnects once (D-82)
— on a rename or a change of this rule, not otherwise; the native client ignores what it does not know (D-58).

**Considered and rejected.** A new role or a per-channel list of who may post (a second permission system beside D-22,
for a team of thirty). Refusing replies too (the announcement would lose its questions, and they would move to a DM
nobody else sees). Letting any channel member set it (the point is that the team's admins decide who speaks for it).
A route of its own (`PUT …/posting`): the channel's other settings are one `PATCH`, told by one frame. Hiding the
composer only in the client (the server is the authority, CONTRIBUTING §1.2). Refusing after the insert (it would write
and roll back on every refusal; the retry is answered by reading first).

**Cost of reversing.** A migration dropping the column and its check, the guard in `sendMessage`, the field in the
`PATCH`, the frame and `Channel`, the notice, the marker and the box, and their strings.
