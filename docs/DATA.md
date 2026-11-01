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
| The object store | Every attachment's bytes and its thumbnail; an owner's export archive; a person's export of their own data | Each upload; each export (D-109, D-140, D-241). The operator's own store, or the one they chose (`CONFIG.md`) |
| A browser's push service (Apple, Google, Mozilla) | An encrypted notice only the device can read: who and why, never what was written. The service sees its size and the device's address | Whatever the person's inbox would show — a mention, a direct message, a thread reply, a group or a channel at their notification level — to a device that subscribed (D-126, D-29) |
| The SMTP relay | A sign-in link, to the address asked for; a letter about what a person missed — the workspace and conversation names, who wrote, and a short excerpt of each message they can still read — to their own address | Email sign-in, when `SMTP_URL` is set (D-138); at most hourly, only to a person who turned it on (D-240) |
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
| `users` | GitHub id, username, display name, avatar address, email, whether it is verified, whether they run the server, whether and since when it is suspended (D-233), whether a password sign-in asks for a second step (D-236), since when they asked to be emailed about what they missed (D-240), language, title, time zone, status, when last seen | Who the person is, and how they sign in | Until erasure, which clears or replaces every one of these but the interface language (D-139 §5) |
| `sessions` | When, from which address and with which browser the person signed in, and the name of the Mac the native application signed in on | Keeping them signed in, listing where (by name and time, never address or browser) and ending one place from another (D-11, D-81, D-193) | Deleted when the session ends — sign-out, sign-out everywhere, a password reset, erasure (D-179) — and within the hour once expired (`sweep:sessions`); `SESSION_TTL_DAYS` at most |
| `accounts` | GitHub's id for the person, or a password's hash (the library's scrypt, on the `credential` row — only the setup's administrator has one); never a password, never a provider's token | How a person signs in, one row for each way (D-179) | Until erasure, which deletes them — the password's hash with them; with the user |
| `two_factors` | An authenticator app's key and the unused backup codes, both sealed under the server's derived secret; whether the key was confirmed; the count of wrong codes in a row and until when the step is locked | Two-step verification for an account with a password (D-236) | Until it is turned off, the server's `admin:reset-password`, or erasure, each of which deletes the row; with the user. Never exported, never shown again after it is made |
| `verifications` | An email address, and a one-time token's value | Sign-in links and the other short-lived tokens the sign-in library issues, a second step's challenge among them (D-179, D-236) | Deleted by the library when used, and on erasure when its value holds the person's address or id. Every row a day after it expired, whatever its identifier (a link, a reset, the state of an abandoned GitHub round trip), by `sweep:email-sign-ins` (its cutoff is in `sweepEmailSignIns`); a row not yet expired is never swept |
| `rate_limits` | A client address, with the path it asked for; for sign-in links, a digest of an email address or of a client address with a count; for wrong passwords, a digest of an address with a digest of the client's network (an IPv4 address or an IPv6 /64), and the network's digest, with a count; and, for invitation e-mails, a person's id or a workspace's id with a count | Counting sign-in attempts and links asked for, and the invitation e-mails sent in a day, so a restart does not hand them back (D-138 §7, D-179 §5) | Deleted by `sweep:email-sign-ins` once `last_request` is a day old — a day past the library's windows, and a day after a sign-in counter's hour closed; an address's link counter, its wrong-password counters, and the person's invitation counter, on erasure |
| `push_subscriptions` | A device's push endpoint and keys, per session | Telling that device what needs its person (D-126) | Until unsubscribed, refused by the push service, or its session ends; on erasure |
| `workspaces` | Who made it; its name and avatar | The workspace itself | For the life of the instance; a workspace is never hard-deleted |
| `workspace_members` | Who is in which workspace, their role, their Deep Work | Membership and permission (D-3) | While they are a member; kept, anonymised, after erasure |
| `workspace_invitations` | Who made an invitation link | Joining a workspace by link (D-115) | For the life of the workspace, as the record of what was offered; usable until revoked or expired |
| `channels` | Who made a channel; a direct message's two or more people (`dm_key`) | The conversation's place | For the life of the workspace |
| `channel_members` | Who is in which channel, their read position, unread counts, notification level, star | Membership and what to show as unread (D-13) | While they are a member |
| `messages` | What was written, who wrote it, question ownership, selected answer and decision note with its last writer (D-204) | The conversation | Retention; tombstoned by a delete or by content erasure (D-9, D-139 §7) |
| `message_versions` | What a message said before each edit | Edit history (D-135) | With its message's words: a delete, content erasure or retention removes them; its author may remove one |
| `attachments` | Each file's name, kind, size, and who uploaded it; the bytes in the object store | Files in the conversation (D-109) | With its message; an unsent upload after `ORPHAN_AGE_MS` (`sweep:orphans`); its bytes leave the store after the row (D-141) |
| `mentions` | Who was mentioned in which message | Notifications and the inbox (D-12) | With its message |
| `reactions` | Who reacted to what, with which emoji | Reactions | With its message |
| `pinned_messages` | Who pinned a message | Pins (D-130) | With its message, or until unpinned |
| `channel_bookmarks` | A link a channel keeps at hand, its name, and who added it | Bookmarks (D-218) | Until removed; with the channel; who added it is cleared on their erasure |
| `saved_messages` | Which messages a person saved, and their state | Save for later (D-128) | Until unsaved; on erasure; with the message |
| `saved_searches` | A person’s named search filters | Personal searches (D-204), never cached results | Until removed; on account erasure; with the workspace |
| `thread_follows` | Which threads a person chose to follow, or let go | Following a thread (D-161) | Until chosen again; on erasure; with the root |
| `notifications` | What a person was told of, whether they read it, and when a letter mailed it (D-240) | The inbox (D-12), and email about what was missed | With its message; on erasure |
| `incidents` | Who declared and resolved an incident; its runbook and postmortem | Incident channels (D-137) | For the life of the channel; not touched by content erasure (D-139 §7) |
| `incident_updates` | Who changed an incident, and what | The incident's timeline (D-137) | With the incident |
| `incident_responders` | Who responded, and who added them | The incident's responders (D-137 §3) | With the incident |
| `audit_log` | Who did what in a workspace, from which session | The workspace's trail of who changed what (D-116) | For the life of the workspace; kept, under the anonymised person, after erasure (D-139 §5) |
| `github_integrations` | Who connected GitHub; the sealed token | A workspace's GitHub access (D-23) | Until disconnected |
| `github_repo_feeds` | Who connected a feed; its repository | Repository feeds (D-134) | Until removed |
| `github_app_installations` | Who connected a workspace's installation of the GitHub App, by id; the GitHub account's login and kind; when it was connected and whether GitHub suspended it | The workspace's reach into its repositories through the App (D-246) | Until disconnected, by an owner or by GitHub's word that it was removed |
| `github_user_authorizations` | The person, by id; their GitHub login and id; their sealed App access and refresh tokens, never in the clear | Letting Purlay write to GitHub as that person, only when they chose to (D-246) | Until the person stops it, GitHub says they revoked the App, or the account is erased; never exported |
| `github_app_handshakes` | The person, by id; the SHA-256 of the state of a trip to GitHub, never the state; for an authorization, its PKCE verifier sealed; where to come back to | Bringing a trip to GitHub back to the person who made it (D-246) | Ten minutes, and spent on return; swept |
| `github_app_deliveries` | None: a delivery's id and its body's digest (D-246) | Telling a repeated delivery to the GitHub App from a new one | `GITHUB_DELIVERIES_KEPT_DAYS` |
| `github_deliveries` | None: a delivery's id and its body's digest (D-231) | Telling a repeated webhook from a new one (D-134 §5) | `GITHUB_DELIVERIES_KEPT_DAYS` (`sweep:github-deliveries`) |
| `link_previews` | A GitHub item's title and state, and its author's login and avatar address, per workspace | Unfurls (D-23) | Until each expires (`sweep:link-previews`) |
| `workspace_exports` | Who asked for an export; the archive in the object store | An owner's export (D-140) | The archive until it is downloaded or `EXPORT_KEPT_HOURS` pass (`sweep:exports`); the row as the record that it was made |
| `personal_exports` | Who asked for an export of their own data, and when; the archive in the object store, which holds their account, settings, the messages they wrote and the files they sent | A person's right of access and portability (D-241) | The archive until it is downloaded, `EXPORT_KEPT_HOURS` pass, or the account is erased, then taken by `sweep:exports` within the hour; the row, ids and times only, as the record that it was made |
| `object_deletions` | None: storage keys waiting to be deleted | Files whose rows are gone, until the store lets them go (D-141) | Until the store deletes the object |
| `job_runs` | None | When each scheduled job last ran (D-30) | Always one row per job |
| `server_settings` | None of a person: who may sign up, the sign-in policy (D-239), the GitHub app's id and its sealed secret, the GitHub App issues are written through — its id, slug and client id, and its client secret, private key and webhook secret sealed (D-246), the mail relay's sealed address (its password in it) and sender, and the GitHub logins listed as workspace creators (D-155) | The server's own settings, changed in the browser (D-179 §6) | One row for the life of the instance. Never exported; the secrets are never shown, only whether they are set. A listed login is a GitHub account's public name, removed by changing the setting — erasure does not reach it, as it does not reach the instance's configuration |
| `server_audit_log` | Who changed which of the server's own settings, and when: the administrator's id and the session, never a value; for a suspension, also whose account (D-233); a person's request for and download of their own data, by their id (D-241) | Administration → Server (D-26, D-179 §4.8) | Append-only; the actor and the account are set to null if that account is erased. Never exported |
| `setup_state` | None of a person: digests of the setup's one-time code and of the claim's token, never either one; the id of the browser that claimed setup; the administrator the setup made, by id; the wrong-code count and lock; the step reached; when a GitHub app and a relay were saved after a try that worked | Setting the server up in the browser (D-179 §4) | One row for the life of the instance. Never exported; the code and the token themselves are never stored — the code is shown only in the log of the start that issued it |
| `admin_email_verification` | The setup administrator, by id, and the address the link was mailed to; the SHA-256 of the one link that verifies it, never the token; when it was issued | Verifying the administrator's address with a link of the wizard's own, not a magic link (D-179 §4.3) | At most one row, for at most a day: deleted when the link is followed or replaced, when it is tried past its day, by `sweep:email-sign-ins` once the day is over, and on erasure. Never exported |
| `invitation_passports` | The SHA-256 of a cookie, or of a lower-cased address — never the cookie, never the address; which invitation link it was made from; when it expires and when it was spent | Letting a newcomer make an account on an invite-only server by an invitation link (D-179 §5) | An hour, once: swept a day past its expiry or its use, and an address's rows deleted on that person's erasure by the digest of the address read before the tombstone. Never exported |
| `missed_mail_letters` | The person, by id; when each letter about what they missed was sent; the SHA-256 of the link in it that stops them, never the link | At most one letter an hour, and a stop link that needs no sign-in (D-240) | Thirty days, while the link opens, then deleted by `mail:missed`; a person's rows on their erasure. Never exported. The letter itself — names and short excerpts of what the person could read — leaves the instance through the operator's mail relay, only to a person who turned it on |
| `native_authorizations` | The person, by id; the SHA-256 of a one-time code, never the code; the challenge the code is bound to (the SHA-256 of a secret only the application holds); when it was made, when it expires and when it was spent; how many wrong guesses it took | Handing a signed-in person's session to the native application (D-191) | Two minutes, once: swept a day past its expiry, and a person's rows deleted on their erasure. Never exported |

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
   **A channel may keep longer, never shorter** (D-225): an owner sets, in the channel's details, a
   window longer than the workspace's or forever; the purge keeps the longer of the two, and the
   workspace's own card says how many channels keep longer. A request to delete everything past the
   workspace's window therefore means setting those channels back to *As long as the workspace* first
   (`channel.retention_changed` on the trail).
3. **How to see it was done:** the workspace's audit log has one `retention.purged` line per run, with
   what was removed. `jobs:status` (`CONFIG.md`, "Production deployment") says when the purge last
   succeeded and fails loudly when it is overdue; a run that left files behind fails too.
4. **What it does not reach:** the audit log, workspaces, members, channels and incidents are kept
   (§2). Backups keep what they held until they are rotated out (§4).

## 4. Erasure runbook

1. **A person erases their own account** in their account menu, typing their username; it needs a
   recent sign-in (D-139 §5). Their profile, email, GitHub link, sessions,
   devices, sign-in links, saved messages and notifications go, and an export of their own data
   can no longer be downloaded, its archive swept within the hour (D-241); what they wrote stays, shown as a
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
   removes it (the example cron is in `CONFIG.md`, "Production deployment"). With point-in-time recovery
   on (`WAL_ARCHIVE=on`, `CONFIG.md`) the archive of the database's log holds them too, until the base
   backups that need it are rotated out and `scripts/prune-wal.sh` has run; a bucket with versioning
   keeps an erased file's versions until its lifecycle rule expires them. A restore before then
   brings them back, and must be followed by the same erasure again. Say how long in your own records.
5. **A copy for the person** before erasing, or on request: **the person exports their own data**
   from Sessions & account (D-241) — their account, memberships and settings, everything they wrote
   that stands, in every workspace, their reactions and saved items and the files they sent, one
   archive downloaded once, each request and download on the server's trail
   (`account.export_requested`, `account.export_downloaded`). Somebody who cannot sign in — a
   suspended account among them — cannot; for them, an owner's export of the workspace (D-140), or the
   operator's `bun run export:workspace <slug> <directory>`, which also carries members' addresses.
