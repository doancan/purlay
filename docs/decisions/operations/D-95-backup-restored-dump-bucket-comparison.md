# D-95. A backup is a directory that has been restored: a dump, a bucket copy, and a comparison

D-44 says a restore is tested on a schedule and D-73 that one is performed before the team moves in.
There was no script for either, and nothing copied the object store at all (#248).

**Decided: `scripts/backup.sh` writes one directory** — `pg_dump --format=custom` taken inside the
database container (so the client is the server's version), the dump's table of contents (reading it
back is the proof it is an archive), every object in the bucket with a manifest of size and SHA-256
(`scripts/bucket-copy.ts`, run in the API image on the stack's network because the store is published
nowhere), and a `SHA256SUMS` over all of it. **`scripts/restore.sh` verifies those sums first**, then
restores into a *new* database by default, refuses a target that already has tables, refuses to
replace the live database while the API runs, and imports only into an empty bucket.
**`scripts/compare-databases.sh` judges the result**: per-table row count and an MD5 over every row,
in a fixed order, plus index and constraint counts; the bucket is judged against its manifest.

**It is rehearsed, not assumed.** `scripts/restore-rehearsal.sh` builds a throwaway stack, fills it with
awkward data, backs it up, restores into a new database and bucket, compares, then destroys every
volume and rebuilds from the backup alone. It runs weekly in CI and on any change to what it covers.
The first run by hand, what it found and what it does not show are
`docs/spikes/backup-restore.md`.

**Rejected: `pg_basebackup` or file-level copies of the data volume.** They restore only onto the same
major version and architecture, and cannot be taken from outside the container without stopping it.
**Rejected: a bucket copy with `rclone` or `mc`.** A tool to install on every operator's machine for an
operation the runtime's own S3 client performs, in the image they already have. **Rejected: compressing
the dump in a pipeline.** A failed `pg_dump` in a pipe can leave a valid-looking empty file and a zero
exit; the dump is written directly and read back. **Rejected: encrypting the backup in the script.**
Key management is the operator's problem and one this project should not half-solve; the spike says
plainly that the directory is plaintext.

**Not covered, said out loud:** point-in-time recovery (WAL archiving, the cloud's requirement in D-44; since
built, D-202), off-host copies, a production schedule, and the `ENCRYPTION_KEY`, which a backup must never carry.

**Reversibility:** free. Scripts and a workflow; the format is `pg_dump`'s and a directory of files.

*Amended 2026-10-09 (a second-round audit that ran it):* four things the first rehearsal could not see.
(1) `restore.sh --replace` dropped the live database **before** reading the dump, so a truncated dump with
regenerated checksums left it with its tables and none of its rows; it now checks the dump reads back and
the target and bucket will accept it, restores into a **staging** database, checks that, and swaps by
renaming, keeping the old one as `<name>_before_restore_<time>`. A failure drops the staging database and
leaves the target as it was. (2) A backup was written with the caller's umask and any local user could read
every message; it is `0700`/`0600`. (3) A backup on a stack whose object store was never initialised left a
partial directory with no checksums; it now removes it and points at `scripts/production-init.sh`.
(4) The default restore put the database in a new place and the bucket into the live one, which refused
after the database was done; both now default to new names, `--bucket live` is the recovery spelling, and
the bucket is checked **before** the database is touched. The rehearsal asserts each of them. `--no-bucket` restores the database alone, for rolling back an upgrade: the live bucket is not empty, and a schema migration does not touch attachments.


*Amended 2026-10-09 (a second-round audit):* the `restore-rehearsal` workflow had the same path filter and
now runs on every pull request, deciding inside the job whether the change touches what it exercises, so
`rehearse` can be a required check. The weekly run and a push always rehearse.
