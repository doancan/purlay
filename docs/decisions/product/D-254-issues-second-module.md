# D-254. Issues, the second module, as small as it can be — builds on D-250

*Amended by D-355: §3's "a member who leaves does not rewrite their issues" is reversed: a person who stops being a member is taken off the workspace's open issues, told by the core's `core.member-left` through the outbox.*

**Context.** D-250 made the architecture and chat its first module, and a rule written for one module is a guess until
a second one lives by it: chat's tables are the core's own migrations, so every seam that matters for a module with a
set of its own — its tables absent, its hooks, its routes, its chunk — has so far been argued and never exercised.
The owner chose to build the second module now, with the least product that touches every seam.

**Decision.** An `issues` module (`features/issues`, `migrations/issues/`, `web/features/issues`) that holds one
record and says no more.

1. **The record.** A workspace's issue: a title (1 to 200 characters, one line), a markdown body (at most 10 000), a
   status (`open` or `done`), an assignee (a current member or nobody), who made it, and two times. Listed newest first
   in keyset pages, narrowed by status; made, changed and deleted. No comments, labels, attachments, notifications,
   search, frames, or link to GitHub: none is needed to prove a seam, and each is a decision of its own. *(Amended 2026-11-07,
   D-283 §8: the notification of an assignee and a search source are decided; the rest stands.)*
2. **Who may.** Any member makes an issue and changes any issue; the last write wins, there being no version worth
   conflicting on. **Only its creator, or an owner or an admin, deletes it**, and deleting is for real: nothing hangs
   off an issue, and a soft delete would be a column and a filter on every read for a record nobody asked to keep
   (D-9 is about messages). The check is the server's, in the same transaction as the delete.
3. **Data.** One table in the module's own set, `issues/0001_issues`, owned by `issues`: keys to `workspaces` (cascade)
   and to `users` (`SET NULL`, as a channel's creator is), every key indexed, no key to another module. The assignee
   being a member is the service's check under the membership's share lock, not a key: a member who leaves does not
   rewrite their issues.
4. **What its hooks do when its table was never made — decided here, as D-250 left it.** Issues is held **whether or not
   it runs**, as the tables of chat's own set are: its erasure, purge and export contributions are in every process's
   composition (no flag decides it: every bundled module is held, `composition.ts`), and each asks `tableExists` at the moment it needs the table, the purge for every table it
   names and the exports through the contribution's `ownSet`. So on a database that never had the set (`MODULES=chat` or
   `none` on a fresh install) there is nothing to reach and nothing fails, and on one where the set was applied and the
   module was then turned off the rows are still taken off an erased account's assignments, purged with a deleted
   workspace and exported. This closes what the first cut of this decision left open — holding the hooks only while the
   module runs, which would have left a deleted workspace's titles and bodies in the database for good — and it costs
   what chat's cost: a check per hook, and a catalogue that names a table some databases lack. `module-lifecycle.integration.test.ts`
   runs every step in every state of the database (core alone, chat's set, issues' set, every set) against every
   process (no module, each alone, both). A process that *runs* issues on a database without its set is not a cell:
   readiness refuses it.
5. **An erased account** leaves its issues as it leaves its messages: the **text stays**, attributed to the anonymised
   account (D-139 §5), because an issue is the workspace's record and not the person's — erasing it would take a team's
   plan with its author — and the person's own data in it is only the id the anonymised row already is. **That is a
   recorded decision, not an oversight**: a person who wants their words gone asks the operator for content erasure, which
   does not reach issues today (it is about messages), so an issue's words are removed by deleting the issue. The account
   is taken off any assignment.
   - **What a title and a body may hold.** A title is one line and uses the `name` format — no newline, control character
     or bidirectional override (`gpj<RLO>exe` would read as another word), something visible — and a body the
     `plain-text` format, lines allowed, no NUL: the database cannot store one, and the answer is a `400` naming the
     field, as chat's names and topics are.
   - **What is on the trail.** Making, finishing or opening again, giving or taking back, and deleting are written to
     the audit log in the same transaction (`issue.created`, `issue.status_changed`, `issue.assigned`, `issue.deleted`),
     by id and by the two values of a change, never the words (D-222); a rewrite of the words is not an entry, since the
     trail says who did what to whom and not what they wrote.
   - **How many.** A workspace holds at most 10 000 issues (`ISSUES_PER_WORKSPACE_MAX`); the one after is
     `409 ISSUES_LIMIT`. **A count, not bytes**: an issue is already bounded by its own limits, so a count bounds the
     table's share of a workspace with one comparison, made under the workspace's row locked so that two makes at the
     cap cannot both pass, where byte accounting would be a column every write keeps in step and a second number to
     explain, for a record nobody keeps ten thousand of on purpose.
6. **Routes** are `/api/workspaces/:workspaceId/issues` and `/…/issues/:issueId`, in the manifest, so a process that
   does not run the module answers the plain `404` of any unknown path (D-250 rule 3). `GET /api/me` and
   `GET /api/client` list `issues` where it runs. *(Amended 2026-11-04, D-255 §5: only `GET /api/me` lists it; the public
   handshake names no module.)*
7. **The web** loads the screen as a chunk of the module's own, by one `import()` from `load.tsx`, drawn at
   `/w/:slug/issues` behind `ModuleGate`, with a rail link and a palette entry only where the session lists the module.
   `budget:web` fails a build whose initial chunks carry the screen's code.

**Rejected.** *A richer first cut* (comments, labels, assignment by team): each would be argued for its own sake, and a
module that proves a seam with six features proves it six times. *Soft delete*: above. *Dropping the key to the
assignee in favour of the service's check alone*: the key is free and keeps the table honest; only the *membership* is
the service's. *Putting issues' rows in the core's migrations* (what the `dataInCore` flag then named): it would put the module's rows in the core's migrations and defeat the
first thing the module exists to show. *Holding its hooks only while it runs* (the first cut): it leaves a purged workspace's rows behind where the module was
turned off, and an erased account's assignments. *Catching the error of a missing table*: an error as control flow, and
it would hide a real fault.

**Cost of reversing.** Dropping the module is deleting its folders, its row in `bundledModules`, the set's directory and
its entry in the owner list; its table stays until an operator drops it (D-250 rule 5).
