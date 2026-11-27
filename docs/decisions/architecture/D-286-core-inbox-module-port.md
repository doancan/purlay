# D-286. The core's inbox is a table a module writes through a port, in its own transaction, listed only for the modules that run — builds on D-283; amends `MODULES.md` §4, §5, §8 and §10

**Context.** D-283 §4 decided that the notices of any module live in a core table of their own, written through a
`NotificationSink`, and left the shape of the table, of the sink's refusals and of what keeps and removes a row to the steps that
build them (`MODULES.md` §10, steps 14f to 14h). This decision is those shapes, for the first consumer that exists: issues telling
an assignee, which is written in the same transaction as the assignment.

**Decision.**

1. **The table is `inbox_entries`, owned by the core** (`TABLE_OWNERS`), made by a migration of the core's set with its indexes.
   A row is one notice for one person in one workspace: the module it is of, a `kind` that is text and not a core enum, who acted,
   what it is about (a type of the module's own word and an id, with no key to the module's tables), at most 1 KiB of short plain
   `params`, and `read_at`. Both keys to the person and the workspace cascade; the actor's is `SET NULL`.
2. **One unread notice for a person about a subject** (`uq_inbox_unread_subject`, over the person, the workspace, the module,
   the kind and the subject), so that telling a person again of what they have not read is one row. *Amends D-283 §4's sketch in
   one respect:* the workspace is part of that key, so an upsert could not move a row between workspaces even for a module that
   passed an id that is not unique. Telling again **raises** the row: it takes a new id (a list ordered by id then shows it
   first), the newer actor and the newer words. A read notice is history; telling again makes a new row.
3. **The sink is the one writer** (`modules/inbox/sink.ts`, the port in `platform/ports/notification-sink.ts`). It runs in the
   transaction the caller gives it, so a notice is committed with the thing it is about or not at all. The module a row is of is
   the module whose manifest declares its kind, which the composition holds for the modules that run (`noticeOwners`): a caller
   passes no module name to get wrong. It **refuses with an error** a kind no running module declares (so a module that is off
   writes nothing, loudly), an id that is not an id, a subject type of the wrong length, and `params` that are not at most eight
   named plain values of at most 1 KiB; the caller's transaction rolls back. It **writes nothing and says so by answering
   nothing** for the one who is acting and for a person who is not a current member of the workspace or whose account is erased,
   read under a share lock so that a member removed at that moment is not told. The current workspace is locked before the
   recipient, matching account erasure and the insert’s foreign-key lock order; a deleted workspace is skipped even through
   an earlier context. A notice of a workspace never reaches a person of another.
4. **Only the sink writes it** (`core-tables.test.ts`): no file of a module names `inbox_entries`, and a module's typed handle
   does not hold the table (`CORE_READS`), so a module cannot write around the sink's checks.
5. **A notice outlives neither its reader's interest nor the person.** `sweep:inbox`, a core job in every process (the rows are
   there whether or not the module that wrote them runs), deletes what was **read over 30 days ago and every notice over 180 days
   old** (the owner's decision, D-283 §8.4), in batches of a thousand. An erasure deletes the person's rows in its own transaction;
   another person's row that names them as the actor keeps naming the anonymised account (D-256). A deleted workspace's purge
   takes the table's rows with the tables that still name it. The person's own export holds their notices; a workspace's holds
   none, with the reason (`CORE_EXCLUDED`).
6. **The routes** are the core's, `GET` and `POST` of `/api/workspaces/:workspaceId/inbox` and `…/inbox/read`, answering in a
   process that runs no module. The list is the caller's own, newest first by keyset on `id`, with the count of every unread
   notice of theirs in the workspace; it holds **only the modules this process runs**, and so does the count and a read of all,
   so a module that is off keeps its unread notices for the day it runs again. A read names ids or says `all`, answers `204`
   and is idempotent: an id that is not the caller's, in this workspace, of a module that runs, or is read already is not read
   and not reported, as chat's `PUT /api/notifications/read` does, so there is no answer that says whether another person's
   notice exists. *Amends D-283 §4's sketch:* it said `404` for another person's id; a silent no-op tells a prober nothing at
   all. A write that moves the inbox is told after the commit, on the person's own topic only, as `INBOX_UPDATED {
   workspaceId }`: a frame of the core's own, additive, which a client built before it ignores (D-82), and which the web reads
   again on each open of the socket (D-268). `purlay_inbox_entries_total{module,kind}` counts what committed, its labels the
   kinds the manifests declare and nothing a caller sent.
7. **Built in three steps, each alone:** the table, the port, the sink and the lifecycle above (14f); the routes that list and
   read, the `INBOX_UPDATED` frame and the metric (14g); and issues' assignment notice (14h). Push and the web's *Updates* section
   are later steps (14i, 14j) and are not decided here beyond D-283 §8.
8. **Issues' assignment notice** (14h): `createIssue` and `updateIssue` call `notify` as their last write, in the route's
   transaction, and the route calls `announce` once it has committed, so a notice that cannot be written takes the assignment
   with it and a rolled-back assignment has told nobody. It is written when the assignee *changed* to somebody, never for a
   retitle or a status change on an issue already theirs. The kind `issue_assigned` is declared in the manifest as not
   `needsYou` and not `pushed` for now: those flags say what chat's badge counts and what a device is told, no inbox notice
   reaches either until 14i and 14j, and a declaration that promises a push which does not happen is false; they are flipped in
   the step that makes them true. `notification-kinds.test.ts` holds chat's kinds to the wire's `NotificationType`, `NEEDS_YOU`
   and the database's enum, and another module's to a name of its own.
9. **A module's notice is pushed, and the push waits for Deep Work and quiet hours** (14i, decided by the owner in D-283 §8.2). The
   sink, after the commit, hands the notices of the kinds declared `pushed` to the push sender (`toldInbox`), which looks each
   entry up again (still unread, person and workspace not erased or deleted), asks `inDeepWork` (Deep Work and the person's quiet
   hours on their own clock), and tells the devices of those who are free and not in front of the workspace's page. Who is in Deep
   Work is **held in memory, on the node that committed the notice**, asked again every minute, told once they are out of it, and
   dropped and counted (`purlay_push_failures_total{reason="dropped"}`) after 24 hours, the time a push service keeps a message for
   a device that is off. The words are the declaring module's (`BundledModule.noticeWords`, who and why, never the title or any
   `params`) and the push lands on a path of that module. The columns of quiet hours and Deep Work (`users.quiet_days`,
   `quiet_from`, `quiet_to`, `workspace_members.deep_work_until`, `is_deep_work_active`) now have a second reader, the core's
   sender, so by `MODULES.md` §5 they leave `CORE_COLUMNS_FOR_A_MODULE` in this change and its cap falls from 14 to 9.
   `issue_assigned` is declared `pushed`; `needsYou` follows with the badge (14j).
   **Amended 2026-11-09:** a queued device also rechecks the entry's current unread state, recipient,
   workspace membership, account suspension and deletion before posting. Deep Work or quiet hours
   starting while it waits hold that device; on release only the held devices are routed again, so
   devices already told are not told twice. The same in-memory bound and expiry still apply.
10. **The web's Updates section** (14j, decided by the owner in D-283 §8.3): a category of the inbox beside Mentions, Direct and
    Threads, never merged into them. It lists `GET …/inbox` and reads with `POST …/inbox/read`, painting a read at once and asking
    for the list again when the server refuses. It is offered only where a running module's *web* manifest declares `notices` (the
    kind, the sentence that takes who did it, the place it opens), so a server whose modules write none shows no empty tab and
    asks for nothing. A kind the page does not know, which a newer server may send, is said plainly by its module's name, opens
    nothing and is still read: the page never breaks on it. The list is its own lazy chunk, so the first load carries the rail's
    dot (a page of one row, the server's own count) and none of the list. `issue_assigned` is now `needsYou`. *Not built:* the
    inbox screen is chat's, so a server that runs issues and no chat has no Updates to open.
11. **The sink is the caller's, and a feature does not import the composition** (an audit of 2026-11-08 found both open). The
    module a notice is written as was taken from the manifest that declares its kind, so a module `zz` could write
    `issue_assigned` and the inbox listed it under `issues`. A sink is now made for one module (`notificationSink({ module, … })`,
    given the id of the module whose routes are being made in `ingress/http/app.ts`), writes every row as that module, and refuses,
    by an error that rolls the caller's transaction back, a kind the module does not declare in its own manifest, whether another
    module declares it or none does. The id is bound where the port is made, so a call cannot pass another's. Separately, a
    feature's code (not its tests) is kept from importing `composition.ts` by the lint (`feature-fences.mjs`; its `http/` folder
    already was), since the composition holds every module's slot and a feature that imported it could open another's. A
    module that is handed the wrong sink is a bug of the composition root, which is one file and read by review.
12. **What one person can be told is bounded** (an audit of 2026-11-08, red-team F8): a member could assign sixty issues to a colleague
    and every one was a row, a badge count and a push, bounded only by the write budget. Three bounds, none of them a refusal that
    hides what is happening now:
    - **Unread notices of one module for one person in one workspace are at most `UNREAD_PER_MODULE_MAX` (200).** The write that would
      make one more reads the *oldest* unread as history in the same transaction (`read_at`, never a delete, so the sweep treats it as
      any read one and an export of the person's own notices still holds it), and the sink answers how many (`collapsed`). It is counted
      in `purlay_inbox_collapsed_total{module,kind}`, labels the manifests declare. Per module, so one module's flood cannot read
      another's; per workspace, because the list and its count are. Telling again of a subject raises the row as before and collapses
      nothing. It is a bound and not a lock: two writes at once may leave one or two above it until the next write, which `OFFSET` in
      the unread index then clears; a serialising lock on every recipient would cost every assignment for a case a person does not meet.
    - **A person's pushes of one kind of one module are three at once, then one a minute** (`NOTICE_PUSH_BUDGET`, the sender's own,
      kept in the node's memory like what Deep Work holds). A push past it is dropped and counted
      (`purlay_push_failures_total{reason="throttled"}`); the notice is in the inbox in any case. Provisional (O-4).
    - **Listing the inbox is charged to the person** (`INBOX_LIST_BUDGET`: sixty at once, then ten a second, before the membership is
      read), as the find is (D-285 §6). Marking read is a write and spends the write budget already.
    *Rejected:* refusing the newest notice, which hides the assignment that is happening now behind the old ones nobody read; deleting
    the oldest, which loses a row an export holds; a per-sender rate in the sink, which an author with several accounts walks around and
    which is the write budget's question; coalescing the held pushes into one body, a new kind of push for a case the throttle bounds.
13. **A worker's visit and a fact's consumer notify through the same sink, with no actor** (the tasks module's overdue sweep): a loop
    written per workspace (D-289 §10) is handed `inWorkspace(turn, work)`, which runs `work` in one transaction with the module's
    `notify` over it, and a consumer's handler is handed `seam.notify` for its delivery's transaction. Both call `notifyIn`, which
    holds every rule of `notify`: the kind is the calling module's own (the sink is bound to the module), the recipient a current
    member, a stopped module writes nothing, the notice is committed with the transaction or not at all. What differs is who is
    acting: nobody, so the notice has no actor (`actor_id` is null) and is owed to the recipient whoever caused it, and the workspace is
    a scope the framework handed out (`workspace-turn.ts`: minted by the walk of the entitled workspaces and by the delivery, refused
    otherwise, as a request's context is refused unless the membership guard minted it), which also says which modules it may use, so a
    workspace that lost the module hears nothing. Notices are announced after the commit: by `inWorkspace` for a worker, by the
    delivery for a consumer, and not at all for one that rolled back. *Rejected:* handing a worker a `WorkspaceContext`, which is a
    person's membership and would need a person; letting a module name the workspace, which is believing it.

**Rejected.** *A notice written by the caller's own SQL*: the checks of the kind, the recipient and the size would be repeated in
each module, and the first one that forgot would write a stranger a notice. *The module named by the caller in each call*: a lie
the type cannot catch; it is the sink's own (§11), bound where it is made, and the manifest that declares the kind is the one place that says whose the kind is. *A unique key without the workspace*:
D-283's sketch; it is correct only while every subject id is globally unique, which a module's id is not obliged to be.
*Keeping the old row's id when raising it*: a list ordered by id would then leave a notice told again where it was. *A separate
retention for each module*: a person's inbox is one list, and a rule per module is a rule nobody can state. *A held push in a table, with a job that sends it when Deep Work
ends* (§9): a column on every notice and a scheduled process that would need the push keys, to keep a hint that a restart may lose
and whose notice is in the inbox in any case; a held push that is lost to a restart is one a person finds in the list.

**Cost of reversing.** The table is new and additive, so a node of the release before ignores it; a rollback is the backup's
(D-86). Dropping it loses only notices, which are short-lived by design.

**Amended by D-307:** accepted browser delivery work, per-device attempts and admission now survive
restart in PostgreSQL; RAM wake-ups no longer own the work. Current source/device authority is checked
on every bounded attempt, and disabling cancels accepted work without cascading through busy devices.
