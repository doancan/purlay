# D-115. Invitations are links — closes O-2

*Amended 2026-10-21 by D-179:* an invitation is accepted only by an account whose address is verified, and
may be sent by email where the server has mail, saying so when the send fails and keeping the link to copy.
The link, its token, its seven days and the rest stand.

Phase 0 let a second person in through one operator variable (D-37), and O-2 left open how a
workspace invites anybody else: an email, a shareable link, or GitHub-organisation membership. #50
needs the answer. Decided in the owner's standing instruction to decide and proceed, and open to
their reversal.

**Decided: a shareable link.**
1. **An owner or an admin makes one**; a member is `403`, judged on the role as it is in the writing
   transaction, read `FOR SHARE`, as member management reads it (D-111). It opens for
   `INVITATION_TTL_DAYS` (seven),
   to anyone signed in who holds it — signed in, not "with GitHub", so Phase 2's other sign-in (D-11)
   needs nothing new here — as many times as it is used, until it expires or is revoked.
2. **It is a bearer secret, kept as a session is** (`platform/tokens.ts`): 32 random bytes, hex, shown
   once in the answer that makes it; only its SHA-256 is stored. It travels in request bodies
   (`/api/invitations/preview`, `…/accept`) and in the client's address after `#` — **never in a path
   or a query**, because the request log writes every path and redaction is by field name.
3. **Joining makes a `member`, into no channel** — as open join and making a workspace do; the person
   joins channels as anybody does. **It never changes a membership**: an owner who opens their own
   link stays the owner (I-2).
4. **A person removed after a link was made is not let back by it.** A removal is a decision; a link
   handed out before it must not undo it. A link made after the removal lets them in. Read from the
   trail's `member.removed`, which the removal writes in its own transaction (D-26).
5. **One refusal**: unknown, expired (at the instant, as a session), revoked, its workspace deleted, or
   its holder removed since — `404 INVITATION_NOT_FOUND`, which says nothing about which.
6. **Revoking wins a race with joining.** A join reads the link `FOR SHARE`, so a revocation that
   committed first refuses it; revoking twice at once is recorded once (`UPDATE … RETURNING`).
7. **Making, revoking and joining are audited** in the transaction that does them
   (`invitation.created`, `invitation.revoked`, `member.joined` with `{ via: 'invitation',
   invitationId }`); nothing counts uses on the link, so a join locks no shared row.
8. **A person not signed in when they open a link** signs in first; the client keeps the token in the
   tab's `sessionStorage` across the round trip — the callback returns to the application's root, and
   a fragment does not survive it — and resumes the join. A return address carried through sign-in
   was rejected: it is an open redirect waiting for one bad check.

**Rejected:**
- *Email invitations.* They need a mail server the self-hosted product does not have (D-7), and the
  owner's team shares links in the chat it is leaving anyway. `SMTP_URL` stays the cloud's.
- *GitHub-organisation auto-join.* It needs the `read:org` scope on every sign-in, an organisation is
  not a team, and it would admit everyone in a large organisation by default.
- *Single-use links.* A team moving in invites ten people at once; one link per person is friction an
  expiry and a revocation already bound.

**Accepted, stated:** a link that leaks admits anyone signed in until it is revoked or expires — the
list shows what is still open, and each join is in the trail with the link it used. Links are rows
that stay: the list reads the open ones by the workspace index, and a workspace that made thousands
is a sweep job's to tidy (D-30), not built until it is measured. `WORKSPACE_OPEN_JOIN_SLUG` (D-37)
is retired with the screens: set, the API refuses to start, naming what replaced it.
