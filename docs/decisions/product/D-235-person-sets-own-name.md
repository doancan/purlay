# D-235. A name is the person's own to set, where it is not GitHub's — amends D-131; closes #853

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-131 kept the name and the picture as
GitHub's, shown and never edited — written when every account came from GitHub. Since D-138 and D-200 an account
can be made by an emailed link, by single sign-on or by the setup with a password; its name is made from its address
(`ada-lovelace`) and nothing let the person change it, so a team of such accounts read each other by handles.

- **Whose name it is.** An account GitHub made, and never connected otherwise (`github_id` set,
  `github_connected_at` null), takes GitHub's name at every sign-in (`recordGitHubSignIn`), so its name stays
  GitHub's: `GET /api/me` says `nameFromGitHub`, the profile shows the name and offers nothing to change, and a
  different `displayName` is `400` on that field. A client that sends the name it was shown changes nothing and is
  not refused. Every other account's name is its own: `displayName` on `PATCH /api/me/profile`, trimmed, held to the
  `name` format and `DISPLAY_NAME_MAX` like any name, never empty.
- **Heard as any profile change is** (D-131 §4): `WORKSPACE_UPDATED` to each workspace the person is in.
- **The picture is not part of it.** An account without GitHub's picture is drawn from its name, as before; a
  picture upload is a separate question about storage and moderation.

**Considered and rejected.** Letting GitHub accounts edit too (the next sign-in would write GitHub's back, so the
edit would last until then — a change that silently undoes itself). Stopping GitHub from writing the name (an account
whose name GitHub changed would drift from it with nothing said). A separate route for the name (the profile's route
already carries what the person says about themselves, and its frame).

**Cost of reversing.** Drop `displayName` from the request and `nameFromGitHub` from `GET /api/me` — an additive field
a client ignores — and remove the row from Profile; names already set stay.
