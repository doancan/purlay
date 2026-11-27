# D-140. A workspace export: what it holds, how it is read, and who may ask — #84

**Context.** D-27 §3 decided an export: workspace-scoped, admin-triggered, NDJSON per table plus the
attachment blobs, produced by a CLI command and downloadable once; PRD §2.5 makes leaving the cloud a
supported operation, not a support ticket. Building it met what D-27 is silent on: which rows are the
workspace's, whose personal data goes with them, and how a large workspace is read without breaking the
database's own limits. A critique of the first plan found it put the download out of reach of an owner
and read the rows in a way the database could not serve; this is what replaced it.

**Decision.**
1. **Two doors, one export.** An operator runs `bun run export:workspace <slug> <directory>` — every
   channel; and an owner asks from the workspace and downloads it once (built in the same issue, after
   the files) — the channels that owner can see (D-34), so an export never shows an owner a
   conversation the product would not. Not a scheduled job (D-30, amended): it runs when asked. The
   owner's is made by the API process that took the request, after answering it — not a timer (D-30's
   concern), a piece of work somebody asked for — archived as one `.tar` (written here: a header and
   padding per file, no dependency), put in the store under the workspace's prefix, and downloadable
   once: the download claims it in the statement that checks it is ready, and the archive leaves the
   store when it has been served, whole or cut off. It is the asker's alone: another owner neither lists
   nor downloads it, since it holds what the asker can see; and an asker demoted or erased before it is
   made is not exported for. One at a time a workspace and a process; kept `EXPORT_KEPT_HOURS`. A run
   says it is alive every minute, and one silent for ten — the process stopped or restarted — is marked
   failed by `sweep:exports`, and the owner asks again; the scratch directory a crash leaves in the
   system's temporary directory is accepted, the operating system's to clear. The sweep claims an
   expired archive before it removes it, and retries an archive the store refused, failing loudly
   while one is left.
2. **What goes** is decided column by column over the generated schema (`modules/export/tables.ts`),
   so a table or column a migration adds fails to compile until it is classified, and a test binds the
   classification to the catalogue. The workspace's record goes; each person's own state — saved items,
   notifications, read positions, stars, notification levels, Deep Work — stays, as D-139 §5 treats it;
   credentials and secrets never go (sessions, sign-in links, devices, the sealed GitHub token, a feed's
   webhook secret, an invitation's digest, storage keys); caches and job records are nobody's.
3. **People** are everyone the exported rows name, by the public projection; the profile only for
   current members — a former member's was set after they left, in another context — and the address
   only in the operator's export, the controller's own records: in the product an address reaches only
   its owner (`models.ts`), so an owner's export carries none. Every bound goes through the scope's
   channels as the database knows them, so an id of another workspace's channel selects nothing.
4. **Read as one snapshot**, `REPEATABLE READ READ ONLY`, through a server-side cursor per table, each
   line written by the database (`row_to_json`) so times keep their microseconds and numbers stay exact,
   one page held at a time. The objects the export names are copied after the snapshot commits: the
   pool ends a transaction idle for fifteen seconds, and a slow store must not.
5. **Written owner-only** (0700 / 0600) into `<directory>.partial`, the manifest last, then renamed; it
   never writes over anything, and refuses a parent others may write into. One `workspace.exported`
   line on the trail, by nobody for the operator — written before the rename, so no finished export
   exists without its line.

**Rejected.** *Pages by id* — no index serves a workspace's messages by id, and reactions have no
workspace column: each page would walk the instance. *One transaction for rows and objects* — the idle
limit ends it. *Every column, filtered by a list of secrets* — a secret added later would leave unseen.
*The download for the cloud only* — PRD §2.5 makes it every owner's.

**Cost of reversing:** none for the data model; the format is versioned by its manifest.
