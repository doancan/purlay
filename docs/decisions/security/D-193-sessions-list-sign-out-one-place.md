# D-193. A person sees where they are signed in, and ends one place — builds on D-60, D-179 §3, D-191

**Context.** D-191 accepted that the native application's session could be ended only by *Sign out* on that
device or *Sign out everywhere*, and said it reverses when a device list is built. An application that lost the
answer to `token` leaves a session nobody can name, and a stolen Mac could be answered only by ending every other
place too. The pieces were all there: `last_used_at` has been kept for this since D-60, and a session is ended by its
row id (D-179 §3), never by a token.

**Decision.**
1. **`GET /api/me/sessions`** answers the caller's live sessions, the one used last first, at most
   `DEVICE_SESSIONS_MAX` (100). Each is `{ id, kind, name, createdAt, lastUsedAt, expiresAt, current }`. `kind` is
   `native` when the session was handed to the application by a code, `browser` for every other; `name` is the
   device name the application sent (`null` for a browser). *Live* is judged by `SESSION_CLOCK`, the clock the
   library judges expiry by, so a lapsed row the sweep has not removed is never listed.
2. **`DELETE /api/me/sessions/:sessionId`** ends one of the caller's sessions: `204`, the row deleted (its push
   subscriptions with it, 0024), its sockets told `SESSION_ENDED` once the delete is committed (D-85). A session that
   is somebody else's, one that never was and one already ended are **one** answer, `404 SESSION_NOT_FOUND`, so the
   endpoint cannot be used to learn whether an id exists. Ending the session the request came in on is signing out
   of it (the cookie is not cleared; `POST /auth/logout` does that too).
3. **`sessions.device_name`** (0057) holds the name, written when the code is spent. It is the *only* thing a
   device list names a session by: the user agent and the address stay for an operator and are never in the answer,
   and the token's digest is not selected at all.

**Rejected.**
- *Reading the name back out of `user_agent`* (`Purlay for macOS/1.2.3 (Name)`): a label this server wrote for
  its operator, parsed back by a pattern that is one edit from wrong.
- *Listing by the library's `/auth/list-sessions`*: it lists token digests and answers `403 SESSION_NOT_FRESH` for a
  session older than a day; its `revoke-session` takes a token, which under the hashing plugin matches nothing and
  answers `{ status: true }` (D-179 §3).
- *Ending the current session with `409`*: a second way to sign out with a different answer for the same effect.
- *A browser's name from its user agent*: a heuristic nobody can hold to a test. A browser's session is `browser`
  with no name; the web shows it as "This browser" or by when it was used.

**Accepted.** A session minted for an application that never saw the answer appears in the list under its device's
name and can be ended: the orphan D-191 accepted is now visible. `lastUsedAt` is precise to the hour (D-60).

**Reverses if** the list is wanted with the address or the browser: then it is a decision about personal data
(D-81), not an addition to this one.
