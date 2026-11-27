# D-202. The database can be restored to a moment, by an archive the operator switches on, and the claim is rehearsed — builds on D-44, D-95, D-185; closes #118

**Context.** D-44 promised point-in-time recovery, a stated RPO and RTO, and a restore tested on a schedule; D-95
built the third and named the first as "not covered". The nightly dump restores the database as it was at 01:00, so
the worst case is a day of messages, and a deletion at 14:00 is recoverable only to the previous night. On
2026-10-27 the host's backup cron was also found to have stopped finding its script after a deploy moved the code to
`releases/<commit>`, and to have said so only in a log: a backup that is not running is indistinguishable from one
that is, until somebody needs it.

**Decided.**
1. **WAL archiving is a switch, `WAL_ARCHIVE=on`, default `off`, on the stack's own compose file.** A small wrapper
   (`docker/postgres-start.sh`) in front of the image's entrypoint adds `archive_mode`, `archive_command` and
   `archive_timeout` only when asked; off adds nothing, which the rehearsal asserts of a running server
   (`archive_mode=off`, `archive_timeout=0`), so a self-hoster with the nightly dump keeps exactly today's behaviour. The
   archive is a directory, a named volume by default or a host path (`WAL_ARCHIVE_PATH`) on another disk or mount.
2. **The archive command is ours, thirty lines of POSIX shell** (`docker/wal-archive.sh`): it compresses to a hidden
   file, checks it reads, and gives it its name by a hard link, so a segment is whole or absent and a name is never
   overwritten; the same segment again is success, a different one under the name is a loud failure; a full or
   missing directory fails. Retention is tied to the base backups, not to a clock: the archive is kept from the
   segment the *oldest base backup on disk* began in (`scripts/prune-wal.sh`, `pg_archivecleanup`), and nothing is
   deleted when no base backup is found.
3. **`backup.sh` takes a base backup when the server says it archives** (`pg_basebackup`, tar, gzip, WAL fetched, from
   inside the database container so its version is the server's), beside the dump, with `base.label` and `base.meta`
   recording the segment it began in and the moment it was complete, in the same `SHA256SUMS`. A bounded wait: the
   backup fails if the archive does not take its last segment.
4. **`scripts/restore-pitr.sh` restores to a named time into a new instance.** The archive is copied into a new
   volume as root and every segment read back whole (the server is a different user from whoever shipped it, and a
   segment it cannot read looks to it like the end of the archive); the base backup is unpacked into another; and a
   new PostgreSQL from the stack's own image replays to `--to` (a time with a zone, or `latest`) in a container with
   **no network** and the copy **read-only**, so it cannot reach the live database or add to the archive. It promotes, is compared with a snapshot (`compare-databases.sh --snapshot` / `--against`) if
   given, and writes a backup-shaped directory that the existing, guarded `restore.sh` applies (staging, rename,
   the old one kept). It refuses, naming why, a time before the base backup was complete (checked by the script, not
   left to PostgreSQL, whose own refusal needs a commit inside the base backup's window), an archive that ends or has a gap before
   the time, an archive without the segment the base backup began in, and a backup with no base backup.
5. **The rehearsal proves it end to end, weekly.** It switches archiving on, takes a base backup, writes, notes a
   time, writes and deletes more, ships the archive off, destroys every volume, recovers to the time from the shipped
   copy, applies it with `restore.sh` and fails unless the comparison finds exactly the rows from before the time.
   It also proves each refusal and that nothing is left running. Its measurements are recorded in the run's summary.
6. **A hook says a night was missed**: `scripts/check-backup.sh` exits non-zero when no whole backup exists, the newest
   is older than 26 hours (by its name's time, never a future one) or does not match its sums, and with `--wal` (which
   declares that archiving is relied on) when archiving is off, the archiver is failing or stalled, or the newest backup
   has no base backup named in its sums. The cron lines in `CONFIG.md` name the paths of the layout `deploy.sh` makes and a
   test builds that layout and runs them as cron would.
7. **The stated numbers**: RPO 60 seconds with archiving on (`WAL_ARCHIVE_TIMEOUT`), 24 hours without; RTO is the
   rehearsal's measurement, recorded, with a design target of an hour for 10 GB that is an extrapolation until measured.
   A test ties the numbers in `CONFIG.md` to the compose default and the script's limit.
8. **Object storage**: the repository states what the bucket must have (versioning, no right to delete a version, a
   lifecycle no shorter than the retention window); it calls no storage service. Garage is believed to keep no versions (untested here; the document says to recheck).

**Rejected.**
- *Logical backups only, more often.* A dump every hour reads the whole database twenty-four times a day for an RPO of
  an hour, and still cannot name 14:03. The dump stays (it is the portable, cross-version restore, and a self-hoster's
  whole story), not as the answer to a point in time.
- *A managed database* (the cloud's PITR is a feature of its provider's service). It does not exist for a self-hoster,
  who is D-1's third audience, and the same claim here would be one the product could not make for the people who
  run it themselves. It remains the better answer for a cloud that has one, and nothing here prevents using it: the
  stack's database is `DATABASE_URL`.
- *pgBackRest or WAL-G.* Better tools, with parallelism, incremental backups, encryption and object-storage targets, and
  the right answer once the database is large. Rejected for now because each is a dependency a self-hoster must install,
  configure and keep in step with PostgreSQL's major version, for a database whose base backup is seconds to minutes;
  this is thirty lines of shell and the tools the image already has, rehearsed. The seam is the base backup and the archive
  directory: a switch to either replaces `backup.sh`'s step and `archive_command`, not the restore's shape.
- *`archive_command` as plain `cp`, or `rsync` to another host directly.* `cp` overwrites and can leave half a file that
  a restore reads; a command that blocks on the network stalls the database's WAL on a network error. The archive is
  local and the copy off the host is a separate, retryable job.
- *Streaming replication to a standby as the recovery.* It is availability, not recovery: a `delete from` replicates in a
  millisecond.
- *Restoring in place over the live database.* The restore is into a new instance and then through the guarded
  `restore.sh`, so a wrong time costs nothing and the live database is only replaced by something that was compared.
- *Pausing at the target (`recovery_target_action=pause`) for inspection.* A recovery that waits for a person is a
  recovery the weekly rehearsal cannot run; the result is compared and then applied or not.

**Accepted.**
- **The archive on the database's own disk dies with the server.** The default is a volume beside the database,
  because a default that needs a second disk is a default nobody gets; the document says so and gives the
  copy-off-host line, and a failing archive (full or unmounted) fills the data disk's `pg_wal` until the database stops,
  which `check-backup.sh --wal` and a separate disk are the defences against, not the stack.
- **Archiving costs disk and a little write time**: a compressed segment per `archive_timeout` of activity, and every
  backup now also reads the whole database a second time (the base backup beside the dump). A backup waits on the
  archive for its last segment, so a broken archive fails the backup after `BASE_BACKUP_TIMEOUT` (half an hour), and
  with it a deploy, which takes one first, until the archive is mended or switched off.
- **The archive holds everything in the clear and an erasure does not reach it** until the base backups that need it are
  rotated out (`DATA.md`); the shipping job runs as root because the segments are the postgres user's, `0600`.
- **Changing the switch restarts the database**, once.
- **After a recovery a new archive must begin**; the old one belongs to the previous history and the command refuses
  to mix them.
- **The bucket is not point-in-time**: attachments are recovered to the backup's moment, and versioning against a
  store that has it is the operator's to set; no script recovers an object as of a time.
- **The RTO is measured on a small database**; on a large one it is an extrapolation, and the operator's own rehearsal is
  the number.

**Reverses if** the base backup's cost (a second read of the database nightly) is found to matter on a deployment, or
one needs encryption, parallel or incremental backups or a bucket as the archive: then pgBackRest or WAL-G replaces the
two shell steps and this entry says so. Switching archiving off is one variable and a restart, and removes nothing.
