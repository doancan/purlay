# D-67. A message is at most 16,000 code units, and the limit is proven to fit the frame

Nothing bounded a message (#190). HTTP accepted five million characters; after D-66 the socket
refused a long one by dropping the connection, and a client that resends pending sends on reconnect
would loop on it. A limit nobody chose had become a disconnect nobody could explain.

**Decided: 16,000 UTF-16 code units, in the contract, at both doors and in the database.** Roughly
four hundred lines of stack trace, which `PRD.md` names as what this product's users paste; a
ceiling that also bounds what the trigram index digests per row. `MESSAGE_CONTENT_MAX` in
`@purlay/types` is the one number. The migration repeats it as a `CHECK` because a job, a script or
an import is a writer too, and an integration test fails if the two part. `char_length` counts code
points, never more than code units, so the database refuses nothing the contract accepts.

*Amended 2026-10-09 (#231): the unit is code units **everywhere, and the database now counts them.**
`char_length` counts code points, which is never more than code units — so it refused nothing the
contract accepts and also accepted what the contract refuses: sixteen thousand emoji, which are
thirty-two thousand units and sixty-four thousand bytes of content, that no 64 KiB frame can carry back
out. `0011` replaces the `CHECK` with one that adds a unit for each character outside the Basic
Multilingual Plane, and an integration test writes 8,000 and 8,001 emoji straight to the table. The
cost is stated: a person who writes in emoji gets 8,000 of them, not 16,000, which is what `String.length`
in their composer already says. **Rejected: counting code points in the contract** — the frame proof
below is made per code unit, and four bytes a code point leaves 1,536 bytes for the envelope, under the
4,096 the test requires. **Whitespace-only content is accepted:** neither `PRD.md` nor `UX.md` says a
blank message is not a message, so refusing it would be inventing behaviour; whether the composer
disables Send on blank is a UX decision for the composer.*

**The frame cap is the reason for the character rule.** JSON escapes a C0 control character and an
unpaired surrogate to six bytes, so without a rule a message's size on the wire is unbounded relative
to its length, and no length limit could be shown to fit 64 KB. Those characters are refused — none
occurs in text a person typed or pasted; tab, line feed and carriage return are kept — and every
other code unit costs at most three bytes. A test measures that for all 65,536 code units, then
builds the longest, most expensive message as a real frame and weighs it.

**`MAX_FRAME_BYTES` moved into the contract.** A client that does not know the cap learns it by
losing its socket.

**Rejected: a byte limit.** It is what the frame cares about, and not what a person can see; a
composer would have to tell somebody their message is too long in a unit they cannot count.

**Rejected: 40,000, as Slack allows.** It does not fit the frame at three bytes a unit, so it would
mean raising the cap — every connection's worst-case buffer — for the rare message that should have
been an attachment.

**Rejected: refusing only by the database.** A `23514` surfaces as `INTERNAL`; the contract refuses
first, with the field named, at both doors.
