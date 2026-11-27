# D-241. A person exports their own data, from their account, in the workspace export's format — builds on D-27, D-139 §5, D-140, D-233; closes #869

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** Erasure existed and access did not: only an
owner could export, and only a whole workspace, so a person exercising a right of access or portability (KVKK, GDPR)
depended on an owner or the operator. A person now asks for a copy of their own data in Sessions & account.

- **What goes is decided column by column** (the core's `modules/export/core-personal-export.ts` and chat's `features/chat/personal-export.ts`, assembled in `export-catalogue.ts`, D-250), typed over the
  generated schema as the workspace's classification is, with every other table named and its reason given
  (`CORE_PERSONAL_EXCLUDED`, `CHAT_PERSONAL_EXCLUDED`) and a test that binds both to the catalogue: a column or a table a migration adds does not
  compile until somebody decides whether a person's own copy carries it. Their account's row, every field (none is a
  secret: the password's hash, the second step's key and the sessions' tokens are other tables', and stay); their
  memberships and what they set on each — the notification level, stars, Deep Work, threads followed; every message
  they wrote and has not been deleted, in every workspace, **in channels and workspaces they have since left too** —
  they wrote them; their reactions, saved items, saved searches and a channel's links they kept; and the files they
  sent with those messages, byte for byte, as a workspace export carries them.
- **Nothing of anybody else's.** No other person's row, words, name or address. A row of theirs names other things by
  id — a message they reacted to or saved — and the workspaces and channels their rows name are written by id, name
  and kind only, so the ids mean something. What is the thread's or the team's stays: who resolved it, who it was
  assigned to, the decision someone noted, its replies; and so do the words an edit replaced and a deleted
  message's, which are not offered back (D-9), mentions and notifications (the words are the others'), and the
  workspace's trail.
- **One format.** The workspace export's (D-140): one NDJSON file per table, each row as the database writes it, the
  files at `blobs/`, a manifest last (`PersonalExportManifest`, `scope: 'person'`), read in one snapshot and archived
  as one `.tar` by the same code. The archive lives under the person's prefix in the store (`u/<id>/`), never a
  workspace's.
- **The same life as an owner's export**, in a table of its own (`personal_exports`): made by the API in the
  background in the process's one export queue, alive every minute, downloaded once, kept `EXPORT_KEPT_HOURS`, swept by
  `sweep:exports` with the workspaces' exports. A table of its own, not `workspace_exports` with a null workspace: an
  owner's list and download are bound to a workspace, and a person's export must not be able to appear in one.
- **The caller's own, always.** Every statement is bound to the session's person; another person's export, one
  downloaded, one expired and an id that is no id are the one `404 EXPORT_NOT_FOUND`. The download is bound to a
  session of the person who asked — not a link that works for whoever holds it.
- **One at a time a person, and three a day.** A second ask while one is made is `409 EXPORT_IN_PROGRESS`, checked
  under the person's row lock (`FOR NO KEY UPDATE`, so their own sends are not held up) and held by a partial unique
  index besides: two asks at once make one export. At most `PERSONAL_EXPORTS_PER_DAY` (3) in any 24 hours, counted
  from the rows, so the limit survives a restart and holds across a cloud's nodes; past it `429 RATE_LIMITED` with
  `Retry-After`. Each export reads everything a person ever wrote; three leaves room for one that failed.
- **A suspended account is refused, by having no session** (D-233). An export asked for and not yet made when the
  account is suspended or erased fails as `EXPORT_REQUESTER_GONE`: nobody could download it, and an archive of a
  person nobody watches is the risk. A suspended person's access request is the operator's to answer (`DATA.md` §4),
  as their erasure is.
- **Erasure ends them** (D-139 §5): in its transaction a ready export becomes `expired` and one being made `failed`, so
  neither can be downloaded, and `sweep:exports` takes their archives out of the store within the hour, as it takes
  every archive a row no longer needs — not `object_deletions`, which holds a workspace's keys only (D-141 §4).
- **On the server's trail.** `account.export_requested` and `account.export_downloaded`, with the person as actor and
  account, in `server_audit_log` and its log line (D-222): the operator answers access requests (D-28), so the record
  that one was asked for and taken is theirs, not a workspace's — a workspace's owners are not told that a member took
  a copy of their own words.

**Considered and rejected.** Sending the person to an owner's export (it holds what the owner can see, not what the
person wrote, and is the owner's). Exporting every message of every channel the person can see (other people's words:
that is the workspace export, an owner's). A second archive format, or JSON in one file (D-140's format already reads a
page at a time and is published). Rows in `workspace_exports` with a null workspace (above). A tokenised download link
that could be mailed (a credential that outlives the session that asked). One export a day (a failed one would block
the person until tomorrow). Writing the requests to each workspace's audit log (the person's own act, about their own
data, across workspaces).

**Cost of reversing.** Remove the card and the three routes, and drop `personal_exports` in a new migration once no
archive is left under `u/`.
