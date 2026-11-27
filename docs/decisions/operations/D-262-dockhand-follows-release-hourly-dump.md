# D-262. A Dockhand server follows `:release`, with a database dump every hour — builds on D-185, D-258; amends D-258 §5

**Context.** The owner's Dockhand server (D-258) should run each release as it comes out, without anyone
setting a digest. GitHub cannot reach it: it is on a private address, and exposing Dockhand's webhook would
put the panel that runs the server on the internet. Dockhand's auto-update can poll an image tag instead,
but the repository's tags were `sha-<commit>` and `main` only — following `main` would run every merge, not
releases. And Dockhand replaces a container with no step before it, so the backup `scripts/deploy.sh` takes at
the switch is not taken.

**Decision.**
1. **`:release` names the latest release's image, and only that.** `release-image` (its own workflow, since it
   writes packages and the release publication job never may) runs after hosted release publication. It resolves
   the latest published release tag, checks out that tag, and gives its tested image (`:sha-<commit>`) the names
   `vX.Y.Z` and `release`. The parent workflow's main tip can be newer than the released commit and is not used.
   Nothing is built. Run by hand with a tag, it names a release already out — and refuses one that is not the
   latest, so `release` never moves back. Before the first release the workflow changes nothing; retrying
   an existing release is idempotent.
2. **Polling, not a webhook.** The stack's `PURLAY_IMAGE` is `…-api:release`, and Dockhand's auto-update checks
   it every fifteen minutes; it compares digests, so it pulls only when a release is out.
3. **A dump every hour, in the stack.** `docker-compose.dockhand.yml` gains a `backup` service on the database's
   own image: `pg_dump` every `BACKUP_EVERY_MINUTES` (60) into a `backups` volume, written aside and renamed so
   a dump by its name is whole, the newest `BACKUP_KEEP` (48) kept, unhealthy when the newest is older than two
   intervals. An update therefore lands with a dump at most an hour old. Going back is a `pg_restore` from that
   container and the previous release's tag (DEPLOY.md). This amends D-258 §5: updates are no longer only the
   operator's, and the backup is no longer only theirs either.

**Rejected.** *Dockhand's Git webhook*: the panel exposed to the internet, and it redeploys a Git stack, not an
image. *Following `:main`*: every merge, not a release. *A dump taken by the API before it migrates*: its image is
distroless and has no `pg_dump`, and a second migration path to keep in step with the first. *A backup before the
switch by Dockhand*: it has no such hook. *Dockhand's own volume snapshots*: a running database copied as files
is not a backup.

**Cost of reversing.** One workflow and its script, one service in the Dockhand file; servers pinned by digest
are untouched.
