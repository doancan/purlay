# D-11. Identity: GitHub OAuth only, database-backed sessions

*Amended 2026-10-21 by D-179:* Better Auth owns sign-in and sessions from here; the opaque cookie
validated against `sessions`, and the hash in place of the token, stay — held by a plugin of ours — and
GitHub is no longer the only way in.

- `users.github_id` becomes **nullable** (free option value for D-5's Phase 2 magic links);
  `email` stays unique and is the identity anchor.
- A `sessions` table is added. The previous drafts promised "cryptographic validation" of a
  cookie without specifying JWT or DB lookup.
- **Chosen: opaque token in an HttpOnly cookie, validated against the `sessions` table.**
  Revocation ("sign out everywhere", "this device was stolen") matters more here than saving
  a database round-trip — and we already query the database on every request anyway.
- **Rejected:** stateless JWT. Cannot be revoked before expiry.
- WebSocket upgrade validates the same cookie against the same table before binding the socket.

**Accepted limitation:** every workspace member needs a GitHub account. For a self-hosted tool
whose users are engineering teams this is acceptable in Phase 1, but it *does* exclude
designers, PMs and QA — which is why magic links are Phase 2 and not "never".
