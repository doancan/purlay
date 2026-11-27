# D-256. An erased account stays named where it was the actor or the adder — builds on D-139, D-218, D-26

**Context.** `channel_bookmarks.added_by` and the actor of `server_audit_log` are keyed to `users` with `ON DELETE SET NULL`,
and the documents said the erasure clears them. It does not: erasing an account soft-deletes and anonymises its row
(`eraseAccount`, D-139 §5) and `forgetWhatChatKeeps` deletes only what chat holds for the person, so the key never fires.

**Decision.** The owner accepts what the code does. `added_by` and `actor_user_id` keep pointing at the anonymised account,
which carries no identity (`deleted-user-…`, no address, no profile), and the audit trail keeps its actor. Both tables are
`anonymised` in `TABLE_LIFECYCLE`. `DATA.md`, `SCHEMA.md` and D-218 say so; a bookmark of an erased person is shown as added by
that account, not by no one.

**Scope, checked 2026-11-04.** Every key to `users(id)` was set against `TABLE_LIFECYCLE` and what the erasure does. Besides the two
above, `pinned_messages.pinned_by`, `incident_updates.actor_id`, `incident_responders.added_by`, `incidents.declared_by`,
`incoming_webhooks.created_by`, `github_integrations`, `github_repo_feeds`, `github_links` and `github_app_installations.connected_by`,
`workspace_invitations.created_by`, `workspace_exports.requested_by`, `channels.created_by`, `workspaces.created_by`, the message
columns that name a person, and `setup_state.admin_user_id` keep naming the anonymised account, and the contract shows that account
(`deleted-user-…`), not `null`. What the erasure does delete or clear is what it says in `eraseAccount` and in chat's and issues'
`userErased` hooks (an issue's assignee is cleared). The one column that held the person's own data and was not reached was
`github_app_installations.account_login`: when the App is installed on their personal account (`account_type = 'User'`), it is their
GitHub login. Chat's hook now replaces it, for the installations they connected, with the name their account now has
(`deleted-user-…`, the column is `NOT NULL`), in the erasure's transaction (#997). The installation stays the workspace's: its
`installation_id`, kind and `connected_by` are as they were. An organisation's login names an organisation, not a person, and stays.
The trail's `{ account }` on `integration.app_connected` and `integration.app_disconnected` names the same login and is **not**
rewritten: `audit_log` is append-only (I-9), and the trail is kept under the anonymised person (D-139 §5). The owner accepts that
a public GitHub login of a personal account the App was wired to stays in those lines (and in the structured log's copy of them,
which carries ids only, D-222), and `DATA.md` says so. *(Confirmed by the owner 2026-11-05, #1000: the old GitHub login `{ account }` in those lines is an accepted residue of an erased account. The same change lets the revoke at GitHub renew an expired access token with the refresh token first, best effort, so the grant is not left behind; nothing else about the erasure moved.)*
The comments of migrations 0021, 0040 and 0065 still say an erasure nulls these columns; a migration is checksummed (`migrator.ts`),
so they stand and this is the correction.

**Cost of reversing.** Clearing them would be a step of the erasure's transaction and a loss of who changed a setting.
