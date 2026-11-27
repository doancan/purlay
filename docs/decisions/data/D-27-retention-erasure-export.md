# D-27. Retention, erasure and export — resolves O-3

*Amended by D-225: A channel may keep its history longer than its workspace, never shorter.*

"Nothing is thrown away" (D-2) is the wedge and stays the default. But an operator who is a data
controller must be able to throw things away on request, and a product that cannot delete a
person's data is unusable by any organisation subject to GDPR or KVKK.

**Decided, in three independent pieces:**

**1 · Retention is opt-in and per workspace.** `workspaces.retention_days` defaults to `NULL`,
meaning infinite — the default behaviour is unchanged and the tenet holds. When an operator sets
it, a purge job (D-30) hard-deletes messages older than the window. Enabling or changing it is
itself audit-logged (D-26), because silently shortening a team's memory is exactly the failure
this product exists to prevent.

**2 · Account erasure anonymises, it does not cascade.** Erasing a user clears the personal data
on `users` (email replaced with a non-routable placeholder, `username` becomes
`deleted-user-<short>`, `display_name` and `avatar_url` nulled, and the profile's `title`, `time_zone`
and `status_text` nulled — D-131), revokes every session, and sets
`deleted_at`. Messages are retained with anonymised authorship — this is what keeps a team's
technical history intact and is defensible under legitimate-interest grounds, provided it is
documented. A separate, explicit *content erasure* operation tombstones that user's message
bodies (D-9's mechanism, applied in bulk) for the cases where anonymised authorship is not
enough. Two operations, because they answer two different requests and conflating them destroys
history nobody asked to destroy. (Built as D-139, which settles the edges this is silent on: a thread across the
window, what else of a person is theirs, and who may erase.)

**3 · Export is workspace-scoped, admin-triggered, and machine-readable.** NDJSON per table plus
the attachment blobs, produced by a CLI command (D-30) and downloadable once. Phase 2. (Built as D-140.)

**Rejected:** a single "delete everything about me" button that cascades through messages. It
would take a resolved thread — knowledge belonging to the whole team — with it, which is the
exact loss D-9 was written to prevent.

**Amended 2026-09-09 — who sets retention differs by deployment.** Self-hosted, it stays exactly
as above: infinite by default, and the operator opts in on disks they pay for. In the cloud the
disk is ours, so retention becomes an attribute of the plan — the mechanism is identical
(`workspaces.retention_days`), only the person who sets it changes. **The tenet survives on the
side where it was made**: a self-hoster is never told what to throw away. And under D-28 the cloud
now *performs* erasure as a contractual obligation rather than documenting how an operator would.
