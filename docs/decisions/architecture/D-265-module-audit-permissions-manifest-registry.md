# D-265. A module's audit actions and permissions are manifest fields, so the core reads one registry and a missing entry fails a test — builds on D-26, D-222, D-250, D-260

**Context.** Two modules run, and what each adds to the places the core leaves open was still written by hand in the core:
the audit actions were one list in `@purlay/types`, a type in `modules/audit/audit.ts` and an exhaustive `switch` in the
settings page, and the role rules ("an owner or an admin may…") were conditions inside each service. A third module had
to be added to all of them by someone who remembered; the compiler caught a missing sentence, and nothing caught an action
a module wrote that its manifest did not own, or a permission a service asked that nobody had declared. A module that is
off could not be told apart from one that is on in any of them.

**Decision.**
1. **`auditActions` and `permissions` are manifest fields** (`MODULES.md` §2). A module lists the actions it writes, in
   groups that name the permission that reads them, and the permissions it owns, each `<id>.<what>` with the lowest role
   that holds it. The core's are `CORE_AUDIT_ACTIONS` and `CORE_PERMISSIONS` (`audit.read`, an owner and an admin, as the
   trail always was). The registry refuses a permission not named for its module or declared twice, an action two owners
   list or the core already has, a malformed action, and a reading permission that is neither the core's nor the
   module's own.
2. **The core reads one table.** `compose` builds `permissions` (the core's and those of the modules the process runs: a
   module that is off has none, so nobody holds one of its permissions, the owner included) and `auditAccess` (who may
   open the trail, and which actions a role is not shown, judged over every module the build carries because the trail is
   the workspace's record and a module being off hides nothing from it). `auditTrail` and the download both take
   `auditAccess`, so a page, a count and a CSV or NDJSON file leave out what the role may not read under whichever filter;
   `issues.delete-any` is asked of the table in the issue delete. Nothing on the wire changes: `AUDIT_ACTIONS` is still
   the one list a client validates against, and `CORE_`, `CHAT_` and `ISSUES_AUDIT_ACTIONS` split it, a test holding the
   three to it, each action once.
3. **The guards are two-way and read the source** (`audit-emissions.test.ts` and `permission-emissions.test.ts`, which take
   the scan of `module-emissions.test.ts`): an action the module's code records and its manifest does not list fails; so
   does a listed one its code no longer records; so does a permission asked by name at `holds` that nobody declared. A
   permission declared and asked through a constant is held by the constant being the same, and a declared name its source
   no longer writes fails. **Not done here:** the other role rules in the core and in chat (`context.role === 'member'` in
   workspaces, invitations, members, export, retention, channels, message moderation) are not yet named permissions, and
   chat declares none; each moves when its service is next changed, since the move changes the signature of a service its
   tests call.
4. **The web reads the same lists.** A web manifest says `auditActions` as the API's does (both from the module's list in
   `@purlay/types`), and the audit page's filter offers the core's and those of the modules the session lists
   (`auditActionsOf`), so a server that does not run issues does not invite a filter on `issue.created`. A row of a module
   that is off is still on the page, said as it always was. The sentence for each action stays in the page's exhaustive
   `switch`, which does not compile for an action without one.
5. **Notification kinds and search sources are manifest fields.** `notifications` lists each kind a module sends with
   whether it needs the person, is pushed and is mailed (chat's are `CHAT_NOTIFICATION_KINDS`, in the order of the wire's
   `NotificationType`, so the contract is unchanged); `notification-kinds.test.ts` holds the wire's list, `NEEDS_YOU` and
   the database's enum to the declarations, and the missed-mail letter reads its kinds from them. `searchSources` lists the
   ids a module adds to a search. The composition offers a module's kinds and sources only while it runs. **Not done:** a
   fan-out over several sources. A search answers `MessagePage`, messages only; a second source needs a result that names
   its source, which changes the wire and is its own decision, so the field and its checks are here and the fan-out is
   not. The push words and the web's inbox categories stay written per reason, in the core and the client.

**Rejected.** *A permission model of grants, rows per role*: three roles and a handful of rules do not need one, and a
table in the database would make who may do what a thing an operator can get wrong; the minimum role is the rule that has
been in force. *Deriving `AUDIT_ACTIONS` from the three lists*: the union's members would change order and with them the
published contract for no change of meaning. *Hiding an off module's rows from the trail*: audit rows are kept whole as
every module's data is (D-255 §3); only a permission the module owns can hide them. *The permission table in
`WorkspaceContext`*: every membership read in the code would carry a table to answer what two services ask.

**Cost of reversing.** Two manifest fields and the code that reads them, two small files in `module-kit`, and the three
lists in `@purlay/types`. Nothing is stored and the wire is as it was.
