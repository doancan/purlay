# Purlay — Personal Data for Operators (`DATA.md`)

For the person who runs a Purlay instance and must answer for the data in it: what the instance
holds about people, why, for how long, and how to keep a retention window and carry out an erasure.
It is what D-28 says a self-hoster needs to write their own records and contracts, not a contract
itself. **The operator is the controller of everything here; the project is not a party, processes
none of it, and signs nothing** (`DECISIONS.md` D-28). The rules this document describes are owned
elsewhere — retention, erasure and export by `DECISIONS.md` D-27, D-139, D-140 and D-141, the
variables by `CONFIG.md` — and are pointed to, not restated.

---

## 1. Who receives what

**The project receives nothing.** An instance sends no telemetry, no analytics and no usage report
anywhere, and has no account with the project to report to. The project has no subprocessors because
it processes no data.

**The instance talks to these, each because the operator configured it or a person used it:**

| Party | What it receives | When |
|---|---|---|
| GitHub | The sign-in exchange; with a workspace's token, the API reads for an unfurl. A repository feed is GitHub sending events in, not the instance asking | Sign-in (D-11); a pasted pull request or issue link (D-23); a repository feed (D-134) |
| GitHub's avatar host | Each reader's browser asks it for the avatars on the page, directly | Every page with a person's avatar, until avatars are served through the image proxy (`TODO(#110)` in `edge.ts`) |
| The object store | Every attachment's bytes and its thumbnail; an owner's export archive | Each upload; each export (D-109, D-140). The operator's own store, or the one they chose (`CONFIG.md`) |
| A browser's push service (Apple, Google, Mozilla) | An encrypted notice only the device can read: who and why, never what was written. The service sees its size and the device's address | Whatever the person's inbox would show — a mention, a direct message, a thread reply, a group or a channel at their notification level — to a device that subscribed (D-126, D-29) |
| The SMTP relay | A sign-in link, to the address asked for | Email sign-in, when `SMTP_URL` is set (D-138) |
| An error tracker | The API's `error` lines, without anything on the never-logged list | Only when `ERROR_TRACKING_DSN` is set (D-96) |
| Any other web server | A request from the instance, never from the reader's browser | An image a message links to, fetched through the image proxy (D-39) |

Each of those is a processor or a recipient of the operator's, to be named in their own records.

---

## 2. The data map

Every table the instance has, what it holds about a person, why, and how long. **Bound by a test**
(`scripts/data-map.test.ts`): a table the migrations add fails the build until it has its row here.

"Retention" below means the workspace's history window, which an owner sets ("Keep history…",
D-139 §4) and `purge:retention` applies nightly (D-27 §1, D-139 §1–3); forever by default.
"Erasure" means a person's own account erasure (D-139 §5); "content erasure" the operator's command
(D-139 §7). A backup holds whatever was in the database and the bucket when it was taken, until it
is rotated out (§4).

| Table | Personal data | Why | How long |
|---|---|---|---|
| `users` | GitHub id, username, display name, avatar address, email, language, title, time zone, status, when last seen | Who the person is, and how they sign in | Until erasure, which clears or replaces every one of these but the interface language (D-139 §5) |
| `sessions` | When, from which address and with which browser the person signed in | Keeping them signed in, and ending it from elsewhere (D-11, D-81) | Deleted within the hour once revoked or expired (`sweep:sessions`); `SESSION_TTL_DAYS` at most |
| `email_sign_ins` | An email address and a one-time link's digest | Email sign-in (D-138) | Deleted by `sweep:email-sign-ins` (its cutoff is in `sweepEmailSignIns`); a person's pending links on erasure |
| `push_subscriptions` | A device's push endpoint and keys, per session | Telling that device what needs its person (D-126) | Until unsubscribed, refused by the push service, or its session ends; on erasure |
| `workspaces` | Who made it; its name and avatar | The workspace itself | For the life of the instance; a workspace is never hard-deleted |
| `workspace_members` | Who is in which workspace, their role, their Deep Work | Membership and permission (D-3) | While they are a member; kept, anonymised, after erasure |
| `workspace_invitations` | Who made an invitation link | Joining a workspace by link (D-115) | For the life of the workspace, as the record of what was offered; usable until revoked or expired |
| `channels` | Who made a channel; a direct message's two or more people (`dm_key`) | The conversation's place | For the life of the workspace |
| `channel_members` | Who is in which channel, their read position, unread counts, notification level, star | Membership and what to show as unread (D-13) | While they are a member |
| `messages` | What was written, and who wrote it | The conversation | Retention; tombstoned by a delete or by content erasure (D-9, D-139 §7) |
| `message_versions` | What a message said before each edit | Edit history (D-135) | With its message's words: a delete, content erasure or retention removes them; its author may remove one |
| `attachments` | Each file's name, kind, size, and who uploaded it; the bytes in the object store | Files in the conversation (D-109) | With its message; an unsent upload after `ORPHAN_AGE_MS` (`sweep:orphans`); its bytes leave the store after the row (D-141) |
| `mentions` | Who was mentioned in which message | Notifications and the inbox (D-12) | With its message |
| `reactions` | Who reacted to what, with which emoji | Reactions | With its message |
| `pinned_messages` | Who pinned a message | Pins (D-130) | With its message, or until unpinned |
| `saved_messages` | Which messages a person saved, and their state | Save for later (D-128) | Until unsaved; on erasure; with the message |
| `notifications` | What a person was told of, and whether they read it | The inbox (D-12) | With its message; on erasure |
| `incidents` | Who declared and resolved an incident; its runbook and postmortem | Incident channels (D-137) | For the life of the channel; not touched by content erasure (D-139 §7) |
| `incident_updates` | Who changed an incident, and what | The incident's timeline (D-137) | With the incident |
| `incident_responders` | Who responded, and who added them | The incident's responders (D-137 §3) | With the incident |
| `audit_log` | Who did what in a workspace, from which session | The workspace's trail of who changed what (D-116) | For the life of the workspace; kept, under the anonymised person, after erasure (D-139 §5) |
| `github_integrations` | Who connected GitHub; the sealed token | A workspace's GitHub access (D-23) | Until disconnected |
| `github_repo_feeds` | Who connected a feed; its repository | Repository feeds (D-134) | Until removed |
| `github_deliveries` | None: a delivery's id | Telling a repeated webhook from a new one (D-134 §5) | `GITHUB_DELIVERIES_KEPT_DAYS` (`sweep:github-deliveries`) |
| `link_previews` | A GitHub item's title and state, and its author's login and avatar address, per workspace | Unfurls (D-23) | Until each expires (`sweep:link-previews`) |
| `workspace_exports` | Who asked for an export; the archive in the object store | An owner's export (D-140) | The archive until it is downloaded or `EXPORT_KEPT_HOURS` pass (`sweep:exports`); the row as the record that it was made |
| `object_deletions` | None: storage keys waiting to be deleted | Files whose rows are gone, until the store lets them go (D-141) | Until the store deletes the object |
| `job_runs` | None | When each scheduled job last ran (D-30) | Always one row per job |

---

## 3. Retention runbook

1. **Who sets it:** an owner of the workspace, in the workspace menu, "Keep history…" — forever, or a
   window of whole days within D-139 §4's bounds. Shortening it says, before it is saved, what will be
   deleted; the trail records who chose it (`retention.changed`).
2. **What happens:** each night `purge:retention` deletes, in every workspace with a window, the
   messages older than it, and what hangs from them — versions, mentions, reactions, pins,
   notifications, files and their bytes. A thread whose replies are younger keeps an empty row for its
   root until its last reply goes (D-139 §1). The bytes of a file the store refuses to delete wait for
   `sweep:deletions`, hourly, until it accepts (D-141).
3. **How to see it was done:** the workspace's audit log has one `retention.purged` line per run, with
   what was removed. `jobs:status` (`CONFIG.md`, "Production deployment") says when the purge last
   succeeded and fails loudly when it is overdue; a run that left files behind fails too.
4. **What it does not reach:** the audit log, workspaces, members, channels and incidents are kept
   (§2). Backups keep what they held until they are rotated out (§4).

## 4. Erasure runbook

1. **A person erases their own account** in their account menu, typing their username; it needs a
   recent sign-in (D-139 §5). Their profile, email, GitHub link, sessions,
   devices, sign-in links, saved messages and notifications go; what they wrote stays, shown as a
   "deleted user". The last live owner of a workspace with other live members must hand it over
   first (D-139 §6).
2. **What they wrote is erased by the operator**, per workspace or in all of them:
   `bun run erase:content <user> --workspace <slug>` or `--all` (D-139 §7). Each message becomes a
   tombstone; their files go with their bytes. One `content.erased` line per workspace.
3. **Somebody who cannot sign in** cannot erase their account themselves, and there is no operator
   command for it yet (D-139 §5 left it to a separate issue). Erase their content (step 2), and remove
   their membership from each workspace; their account row keeps their profile until they can sign in
   and erase it.
4. **Backups.** An erasure does not reach a backup already taken: `scripts/backup.sh` copies the
   database and the bucket, so erased messages and files stay in each backup until your rotation
   removes it (the example cron is in `CONFIG.md`, "Production deployment"). A restore before then
   brings them back, and must be followed by the same erasure again. Say how long in your own records.
5. **A copy for the person** before erasing, or on request: an owner's export of the workspace
   (D-140), or the operator's `bun run export:workspace <slug> <directory>`, which also carries
   members' addresses.
