# D-323. The console stops and resumes a module, and says before a stop what goes with it — builds on D-296

**Context.** D-296 built the stop as a route and a command and left the console's screen for an operator who should not need a
shell (#1310). Its item 5 says "the console says which" modules stop with the one named, but the list the console reads,
`GET /api/server/modules`, said only what is stopped now, and the writer says what went with it only after it is done. The
confirmation chat needs (`force`) was the same: the console could learn it only from a refusal.

**Decision.**

1. **Administration → Modules** (`/server/modules`) lists every module of the build with its state (running, stopped with its
   reason and time, or out because a module it requires is stopped) and whether this process runs it. A running module has **Stop…**,
   a stopped one **Let it run again**; one that is out because of another has neither, since only the stop it depends on can be
   lifted. The screen is its own lazy chunk inside the console's.
2. **Stop…** asks for the reason the trail keeps (the server's limit, `SUSPENSION_REASON_MAX`; a missing one is the server's
   `VALIDATION_FAILED` said on the field, no copy of the rule in the client, D-142), says which modules stop with it, and, where the
   stop takes the product down, asks for a tick that it is meant before **Stop module** can be pressed; that tick is the route's
   `force: true`. A `409 PEERS_BEHIND` is said in the console's own sentence (finish the rollout, then stop), the dialog stays open
   and the reason stays typed. After a change the screen says what it came to: what stopped or came back with it, or that nothing
   changed and the first reason stays.
3. **The list says beforehand what the writer would answer.** Each `ServerModuleStatus` gains `stopsWith` (what a stop of it now
   would take out of service with it, because they require it, in the build's order) and `stopNeedsForce` (whether that stop takes
   down a module the product cannot do without). Both come from the same closure the writer uses (`outOfService`, `takenDown` in
   `modules/suspension/apply.ts`), so the console cannot promise what the writer would not do. Additive fields of an administrator's
   read: a console of the previous release ignores them.
4. **The cluster check needs no confirmation in the console.** `--cluster-ready` exists because the command cannot see the cluster;
   the route can, and refuses `PEERS_BEHIND` itself (D-296 §8). The console offers no switch that would only repeat what the server
   already knows.

**Rejected.** *Learning `force` from the refusal alone:* the operator would be refused once before every stop of chat, and the
dependents would be known only once stopped. It remains the fallback when the list is older than the server: a refusal on `force`
shows the tick. *Computing the dependents in the browser from the manifests:* a second copy of the closure (§6.1) and of the
`always` rule. *A confirmation for a resume:* a resume takes nothing down and is never refused for the cluster.

**Cost of reversing.** The section and its chunk; the two fields stay harmless if unused.
