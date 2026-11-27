# D-131. A profile: a title, a time zone and a status line, the person's own — #488

*Amended by D-235: A name is the person's own to set, where it is not GitHub's.*

*Amended by D-330: A status line may carry one emoji and clear itself at a chosen end.*

**Context.** The Superdesign screens show, in a conversation and where people are picked, what a
person does, the time it is where they are, and a line about what they are on. GitHub gives a name
and an avatar, which stay GitHub's (D-11). D-125 put profiles in Phase 2.

**Decision.**
1. **Three fields on the person** (`users.title`, `users.time_zone`, `users.status_text`, migration
   0029), each null until set and never blank: a title of up to 80 characters, an IANA time zone,
   a status line of up to 100. Global, as the person is (D-3): the same in every workspace.
2. **The person's own to change** — `PATCH /api/me/profile`; a field left out is kept, `null` clears
   it, words are trimmed, and a field of nothing but spaces is refused as no name may be. A time zone
   is a named zone the server's runtime can format in, stored as the runtime spells it
   (`europe/istanbul` is `Europe/Istanbul`); an offset (`+05`) or a zone it does not know is `400`
   on `timeZone`.
3. **Read where the person is read**: `GET /api/me` carries the caller's, and each workspace member
   carries theirs, so a conversation, the members and every picker have it with no second request,
   and nobody outside a shared workspace reads it.
4. **A change is heard as `WORKSPACE_UPDATED`** by everyone in each workspace the person is in — the
   frame a rename sends, which carries nothing — and a client reads the members again. Nothing
   changed, nobody is told.
5. **No expiry and no emoji on the status**: a line of words, kept until it is changed. A presence
   ("away") is presence's (#480), not the profile's.
6. **Shown where people are met**: a conversation with one other person is headed by their local
   time and status and opens their profile beside it; the picker shows each person's title and local
   time; your own is set from the account menu. A zone a browser cannot format in shows no time, and
   the profile still names it. A note to yourself shows none of yours beside your name.
7. **Personal data**: erasing an account clears the three (D-27 §2), and the status line, free words
   as a message's are, is never logged (`ARCHITECTURE.md` §10). A client back from a gap reads the
   members again, since no frame will say what changed meanwhile.

**Rejected.** *Profile fields on `User`* — every message carries its sender, and every message
would carry a status line. *A `PROFILE_UPDATED` frame* — `WORKSPACE_UPDATED` already reaches exactly
the people who can see the profile and says "read the workspace again". *A status that clears
itself* — a timer per person, for a feature nobody has asked to expire yet.

**Cost of reversing:** migration 0029's columns, one route, the `profile` fields of two responses.
