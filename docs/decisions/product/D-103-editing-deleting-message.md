# D-103. Editing and deleting a message — closes O-1

O-1 asked for the edit window, history retention, and how an edited message in a resolved thread
behaves; #47 needs the answers, and the delete rules beside them. Decided by the owner on 2026-10-11.

**1 · Editing has no window.** The author may edit for as long as the message exists, and the message
says it was edited (`editedAt`). A team that trusts each other gains nothing from a lock on its own
words, and a typo found tomorrow is still a typo. **Rejected: 15 minutes, or a day.** A window makes
the record more trustworthy only where there is a reason to distrust it, and it is the edit history
(Phase 2, `PRD.md` §4) that answers that reason, not a clock.

**2 · No history in Phase 1.** An edit replaces the content; what it said before is not kept.
`editedAt` says that it changed, not what from. Edit history is Phase 2, so this is stated rather than
discovered. *Amended by D-135:* every edit now keeps what it replaced.

**3 · A resolved thread is edited by the same rules.** Resolution is metadata on the root (D-99): it
records that the question was answered, not that the words are frozen. **Rejected: freezing a resolved
thread** — a correction to the answer is exactly what someone reading it later wants to find, and
reopening a thread to fix a typo would announce a question that is not open.

**4 · Only the author edits; somebody else is told `403 FORBIDDEN`.** The 404 rule (D-21) protects the
existence of what a caller cannot see; a member who can read the message already knows it exists, so
refusing them with a 404 would hide nothing and tell their client the wrong thing. Anyone who cannot
see it — another workspace, a private channel they are not in, a deleted message — is told
`404 MESSAGE_NOT_FOUND`, as for every other message route.

**5 · An edit tells the people it names for the first time, and nobody twice.** A name the edit adds
is a mention like any other: a notification, and the mention count where the message is still unread
for them (the same rules as a send, D-99 §1 — a muted member and the author are told nothing). A name
already mentioned, or added before and taken out since, is not told again; a name taken out is no
longer a mention, and what it was told is not withdrawn. The unread count does not move: the message
was already counted. **Rejected: an edit never notifies** — `@alce` corrected to `@alice` would never
reach Alice. **Rejected: withdrawing a notification** — it would have to be unsaid on every device
that already showed it, for a person who has read it.

Somebody already told about the message — the other side of a direct message, the author of the
thread a reply answers — is not told again when an edit names them: one notification per person per
message (D-99 §1), and a second would count them twice and break I-6. They are in the mentions; they
were counted when it arrived. Somebody who joined the channel after the message was written is told
for the inbox, already read: it was never counted unread for them.

**6 · Content the same as stored is not an edit.** It writes nothing and does not mark the message
edited, so a retried request leaves it as the first left it.

**Accepted: the last writer wins.** Two edits are taken one after the other under the row's lock;
there is no precondition, so a late retry of an older edit replaces a newer one. A `baseVersion`
answered with `409` is additive and can come when two devices editing one message is seen to happen.
The message's `state_version` now counts a revision too, ready for the revision frame (#333).

**7 · Deleting** (#47's second slice): the author, or a workspace `owner` or `admin`. The content is
replaced by an empty tombstone (D-9) and the client draws the words; reactions are kept and not drawn.
A deleted **root with replies** stays in the feed as a tombstone with its thread; a deleted root with
none leaves the feed. A deleted **reply** stays in its thread as a tombstone (`Message.deletedAt`:
it occupies its place), so `thread_reply_count` does not drop — a resolved thread cannot lose its last
reply and break I-8. What the message added to unread and mention counts is taken back, never
below zero: a message older than the counters (0013) was never counted, and an author deleting it
must not be refused by a check; the next read recounts exactly. The note in `0014_open_questions_index.sql` that such a thread "drops out of the
index when the count does" is superseded here; the migration is applied and is not edited (D-45).

**8 · Delete for Me** (owner request, 2026-10-28) is a separate account preference, stored in
`hidden_messages`. It hides any visible message from that person's history, search, saves, pins,
files and inbox, and cancels their pending reminder. Other participants keep the original content.
Only the caller's devices receive `MESSAGE_HIDDEN`; reconnect reads preserve the private tombstone.
A hidden root remains as an empty placeholder while it has replies. The existing deletion in §7
is presented as **Delete for Everyone**, with the same author/owner/admin permission.

**Reopened when** Phase 2's edit history lands (§2), or dogfooding shows an edit used to rewrite what
was agreed.
