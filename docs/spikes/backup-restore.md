# Spike — a backup that has been restored

**2026-10-09.** D-73 says a backup is restored once before the team moves in, and D-44 that a restore
is tested on a schedule; until today there was no script, no job and no runbook, and nothing backed up
the object store (#248). This is the record of writing them and of running them on a populated stack.

## Versions resolved

| | |
|---|---|
| Docker Engine / Compose | 29.7.2, on macOS 27.0.1 (Apple silicon) |
| PostgreSQL (`postgres`, `pg_dump`, `pg_restore`) | 18.6 — all three the server's own, run inside its container |
| Garage | v2.1.0 |
| Bun (S3 client, bucket copy) | 1.4.2 |
| The stack | `docker-compose.production.yml`, the API image built from this commit |

## What was run

**The data** (`docs/spikes/backup-restore.seed.sql` and `scripts/rehearsal-seed-bucket.ts`), chosen to be
awkward rather than large: 60 users with Turkish dotted/dotless i, an emoji and a combining accent in
their names; 3 workspaces; 21 channels, two named `İstanbul` and `ıspanak`; 20 400 messages with
time-ordered ids, JSON metadata, threads, a soft-deleted one, an edited one and one at the
16 000-character limit made of multibyte characters; 10 sessions with `inet` addresses. In the bucket,
44 objects, 18 628 174 bytes: 40 small ones, a 5 MiB, a 12 MiB (written as a multipart upload), a key
with `İstanbul ıspanak 🚀` in it, and a one-byte object.

**The first rehearsal, by hand** against the brought-up production stack:

```
$ scripts/backup.sh backups
database: dumping purlay
database: 761906 bytes, 9 tables with data
bucket: copying
exported 44 objects, 18628174 bytes -> /backup
checksums: 47 files

$ scripts/restore.sh backups/purlay-20261009T095059Z --bucket purlay-restore
checking the backup against its checksums
  intact
database: restoring into purlay_restore
database: restored
bucket: restoring into purlay-restore
imported 44 objects; the bucket matches the manifest
restore finished: purlay_restore

$ scripts/compare-databases.sh purlay purlay_restore
table                              rows  checksum                          purlay = purlay_restore
channel_members                     630  d599246da5bacded3dd7ee3f0354fc90  match
channels                             21  ced06706debdf7ee68b3d2dfda69de1f  match
kysely_migration                      7  bbc7ee81b7d705b7809ad7082c816cc3  match
kysely_migration_lock                 1  dd26bafae05fd5efb8390623f41e296d  match
messages                          20400  15f83c3319741f8e32a1b1160900ece0  match
sessions                             10  328d5f7a02b408092325ae4d221ef6f7  match
users                                60  fbc159c07860d4333d5bf45b6783708b  match
workspace_members                    90  d0f6bcf55fc19a196d4167324d9db658  match
workspaces                            3  4e2a39f1a05183a281c5ddce8235d502  match
indexes                              29                                    match
constraints                          91                                    match
identical
```

The checksum is the MD5 of every row rendered as text, in a fixed order, so it sees a changed value
that a count cannot. The restored database was then served by a second API container started against
it with `MIGRATE_ON_START` off: `GET /health/ready` answered `200 {"status":"ready"}` and the log
contained no migration — every migration was recorded and the `COLLATE "C"` columns (D-40) were intact.

*The counts above are those of the seven migrations that existed when the first rehearsal was run by
hand. After the branch was rebuilt on a schema with ten (new indexes and tenant-integrity constraints),
`scripts/restore-rehearsal.sh` was run again and ended `identical` / `rehearsal passed`, both phases.*

**Making the comparison fail**, because it passed first time:

```
update messages set content = content || '!' where ...     (one row, one character)
messages     20400  15f83c33...  DIFFERENT (messages|20400|cbf0d29c...)
the databases differ                                        exit 1
```

The row count was unchanged; only the checksum noticed. Refusals, each observed:

```
restore into a database that has tables         -> purlay_restore already has 9 tables; pass --replace ...   exit 1
--database purlay --replace, api running        -> refusing to replace purlay while the api is running       exit 1
one byte of database.dump changed               -> sha256sum: WARNING: 1 computed checksum did NOT match; not restoring
restore the bucket into one that has objects    -> refusing to import into a bucket that already holds 44 objects
```

**The scripted rehearsal** (`scripts/restore-rehearsal.sh`, also a weekly workflow) does all of the above
on a throwaway project with throwaway secrets and no proxy, and then the case a backup exists for:
it records the live database's per-table counts and checksums, **destroys every volume**, rebuilds the
stack empty, initialises storage, restores over the stack's own empty `purlay` database with the API
stopped and into the service's own empty bucket, starts the API, and diffs the recorded summary against a
new one:

```
== total loss: destroy every volume, rebuild from the backup alone
database: restoring into purlay          database: restored
bucket: restoring into the service's bucket
imported 44 objects; the bucket matches the manifest
rebuilt database: every table's count and checksum is what it was before the loss
the bucket matches the manifest
rehearsal passed
```

With one extra row deleted from the restored copy, the scripted run ends `the databases differ` /
`REHEARSAL FAILED (exit 1)` and removes everything it made (`docker ps -a | grep rehearsal` is empty
afterwards, as are its volumes). The first phase takes about twenty seconds on this machine.

## What had to be loosened

**Nothing in the repository's rules.** No lint rule, compiler flag or coverage floor changed. Operationally:

- The dump and restore use `--no-owner --no-acl`. Ownership is a property of the cluster's roles, which
  differ between servers; a restore onto a new server that tried to recreate them would fail or, worse,
  grant things nobody chose.
- The copy runs in the API image as the *invoking* user (`--user "$(id -u):$(id -g)"`), with the image's
  read-only root filesystem and no capabilities intact, so the files it writes are the operator's. It
  needs no root and no relaxed profile.
- `pg_restore --exit-on-error`: without it a restore that could not apply a statement reports success.

## What surprised us

- **My own test found a hole in the bucket copy.** An absolute key (`/etc/passwd`) did not fail the
  "stays inside the backup" check — `join` made it `<root>/etc/passwd`, inside the root. That is safe, and
  it is also a collision: `a//b`, `a/./b` and `/a/b` all land on the file of `a/b`, so the export would
  have overwritten one object with another and reported success. Keys with an empty, `.` or `..` segment
  are now refused, loudly, at export.
- **The total-loss path found two defects the first rehearsal could not.** `production-init.sh` checked
  that an anonymous read is refused by `exec`-ing into the API container, so it failed when storage was
  initialised before the API ever started — exactly the order a rebuild needs. And `restore.sh` used
  `"${bucket_env[@]}"`, which macOS's Bash 3.2 reports as an unbound variable when the array is empty
  under `set -u`; every earlier run had passed `--bucket`, so the path without it had never executed.
- **The database's own constraints rejected my seed.** The first attempt at a very long message
  (200 000 characters) failed `messages_content_length` (16 000, migration 0007) — the limit working,
  noticed only because the seed ran against a real schema.
- **Garage's RPC secret can come from the environment**, so no secret is in `garage.production.toml`; its
  keys must be in its own format (`GK` + 24 hex) and a *new* bucket needs the key granted, which
  `restore.sh --bucket` does.
- **A pipeline can lie.** `pg_dump | gzip` would exit 0 with an empty file if `pg_dump` failed;
  `backup.sh` therefore writes the dump directly, requires it to be non-empty and reads it back with
  `pg_restore --list` before it counts it.

## Point-in-time recovery (2026-10-27, D-202)

The same rehearsal, extended (`scripts/restore-rehearsal.sh`, after the total-loss step). One run, by hand, on
the author's laptop (Docker Desktop, Apple silicon), PostgreSQL 18 from the stack's own image, a
database of 8 MB (the seed above) and `WAL_ARCHIVE_TIMEOUT=10`. CI runs it weekly and writes the same lines to
the run's summary, which is where the dated record is kept.

- **What was done:** archiving switched on in the env file and the database recreated (`archive_mode` read back
  `on`, and `off` with `archive_timeout 0` before); a backup, which now holds `base.tar.gz`, `base.label`,
  `base.meta`; 500 rows written, edited and one deleted; the database summarised and the time noted; 300 more
  rows, edits, a range deleted and the table dropped and recreated; the archive **copied off as root**, then
  every volume destroyed; `restore-pitr.sh --to <the noted time>` from the backup and the copy; the result
  applied with `restore.sh --no-bucket` into the rebuilt stack.
- **The result:** the recovered database compared identical to the summary taken at the noted time, in every
  table's count and checksum — the 499 earlier rows there, the 300 later ones not, the earlier edit as it was.
  The instance's last replayed transaction was 1.6 s before the time (the commit before it), and recovery
  stopped there, not at the end of the archive.
- **Measured:** `restore-pitr.sh` start to finish **5 s** (base backup 8.3 MB, four archived segments); the
  logical restore of the same data with the bucket, after the same loss, 2 s. The newest commit was in the
  archive **5 s** after it was made, with `archive_timeout` 10 s. No archive attempt failed.
- **Refused, and checked that it was:** a time without a zone; a time before the base backup was complete; an
  archive whose later segments are missing (it ends before the time); an archive without the segment the
  base backup began in; a backup taken with archiving off. Each left no container, no volume and no directory.

**What it found.**
- **A time before the base backup cannot be left to PostgreSQL.** Its own refusal ("stop point before the
  consistent recovery point") fires only when a commit record falls inside the base backup's window to stop at,
  which a quiet database does not have, and the case is not one the rehearsal could set up reliably. So
  `restore-pitr.sh` compares the time with the moment the base backup was complete (recorded by `backup.sh`)
  itself, in the instance, once it answers, and the rehearsal holds that refusal.
- **The archive cannot be read by the host user.** Segments are the postgres user's and `0600`, so the copy off
  the host must run as root (the rehearsal copies in a root container and hands the files back); the document
  says so and puts the shipping job in root's crontab.
- **An archive command that blocks on the network stalls the database**, which is why the archive is local and
  the copy a separate job.

## What this does not show

- **Scale.** 762 KB of database and 18.6 MB of objects; the point-in-time run's base backup was 8.3 MB. Restore time does not extrapolate, and a database of tens of gigabytes needs
  `pg_restore --jobs` and a measured window; none is claimed here. The hour for 10 GB in `CONFIG.md` is a target.
- **Point-in-time recovery.** A logical dump restores to the moment it was taken. WAL archiving, the
  mechanism D-44 asks of the cloud, was built afterwards and is recorded below (D-202).
- **Off-host copies, encryption and a production schedule.** `backup.sh` writes a directory. It holds
  user e-mail addresses and session token hashes in the clear; moving it off the server, encrypting it
  and running it from cron are the operator's, and a cron line is the documentation, not a scheduler
  container (D-30's scheduler is for application jobs).
- **`ENCRYPTION_KEY` is not in the backup**, deliberately: a backup that carried the key that encrypts
  its contents would protect nothing. It is on the production checklist (`CONFIG.md`) as a secret to keep
  separately; a restore without it cannot read stored integration tokens.
- **Garage's cluster layout and key** are rebuilt from the environment by `production-init.sh`, not
  copied; object metadata beyond key, size and content (content type, user metadata) is not preserved by
  the copy, because the application does not set any yet. Attachments (#53) must revisit this when it does.
