# D-233. The server's administrator suspends an account, and lifts it — builds on D-139 §5, D-179 §4.8, D-193; closes #848

*Amended by D-354: the Accounts card of Settings → Server is removed; suspending and lifting are the console's Users page (D-278).*

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** When somebody left, the only ways to keep
them out were erasing their account (which tombstones their name in every conversation, D-139 §5) or removing them
from each workspace, which left them signed in to the server with every session they had. A security review named it;
a team offboarding a person needs it on the day they leave.

- **The server's administrator's, on Administration → Server → Accounts.** Accounts are found by name, username or
  address (words, never a pattern), at most `SERVER_ACCOUNTS_MAX`. A workspace's owner is not offered it: an account
  is the server's, not a workspace's (D-179 §4.8).
- **Suspended is `users.suspended_at`.** Set, every session of the account is deleted in the same transaction and
  each socket is sent `SESSION_ENDED` after the commit. A suspended account starts no session by any way in — the
  library's one session hook refuses it for GitHub, a password, a link and single sign-on alike — and the session
  seam refuses one that slipped past; the native application's handoff refuses it too. Memberships, messages and the
  name stay, so lifting it is the person as they were.
- **Never an administrator.** The caller's own account and another administrator's are `403`: a server whose
  administration suspended itself has no way back but the break-glass command. Demoting an administrator stays the
  operator's.
- **On the server's trail with whose account** (`server.account_suspended`, `server.account_restored`, in the new
  `server_audit_log.target_user_id`). Suspending a suspended account, or lifting one that is not, writes nothing.
- **A sign-in refused for a suspension says what any refused sign-in says.** Saying "suspended" would tell whoever
  holds a password that it is right.

**Considered and rejected.** The sign-in library's admin plugin and its ban (a second model of who administers the
server beside `is_server_admin`, and its ban expiry and reason fields are features nobody asked for). Suspension per
workspace (removing a member already exists; what was missing is keeping the person off the server). A reason or
an expiry on the suspension (YAGNI: lifting it is one click). Suspending from the Members page (a workspace's page,
for an act on the whole server).

**Cost of reversing.** Drop the column in a new migration — which lifts every suspension at once — and remove the card
and the three routes.
