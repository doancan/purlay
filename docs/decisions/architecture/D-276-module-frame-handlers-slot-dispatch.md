# D-276. A module's frame handlers are a field of its slot, and the router dispatches by ownership — builds on D-250, D-255, D-266, D-270; amends `MODULES.md` §3 and §9

**Context.** The manifest said which client operations a module owns (`frames`) and the composition closed them where the
module is not run, but nothing said how a module *serves* one: `realtime/router.ts` ran chat's `SUBSCRIBE` with its replay,
`UNSUBSCRIBE`, `MESSAGE_SEND` and `TYPING` itself, imported chat's guard, send path and replay to do it, and was an allowed
chat importer in `module-seams.test.ts` because the manifest had no field for a handler. A second module's frame could not be
added without editing the core's router, and the checklist did not say so.

**Decision.**

1. **`frameHandlers` is a field of the module's slot in `bundledModules`**, beside `jobWork`, not of the manifest: the manifest
   is types and strings that `module-kit` carries without the platform, and a handler is code that takes the platform's
   context. One handler per operation of `frames`, typed by the contract's frame for that operation
   (`platform/frame-handlers.ts`: `FrameHandlers`). A handler for an operation the manifest does not name stops the build, as
   work for a job it does not name does. A module that is not run supplies none (`compose`), and its operations stay answered
   as ones nobody has (`closedFrame`).
2. **The router does what is the same for every operation, before the handler and around it**: the connection's frame budget
   first (malformed frames included), the contract's parse, the closed answer, then the handler inside the module's deadline
   and share (D-270, D-266), with what it throws answered as the router always answered it (`AppError` as it is, a purged
   message as `MESSAGE_NOT_FOUND`, a busy pool as `DATABASE_UNAVAILABLE`, anything else `INTERNAL` with the cause logged
   once) and the frame's `refId`. `PING` and `ACTIVE` are the router's own. The router names no module and no operation of
   one: an operation that is neither its own nor served is answered as one nobody has.
3. **The context is the connection's, and a module names the part it uses.** `FrameContext` carries who is speaking, the
   application's database (whose every connection is the module's share, D-266), the transaction boundary, the bus, the clock,
   the log, the user's write budget, and `reply` and `fail`, which stamp a frame as the router does. What the socket carries
   beyond that (push, who is typing) reaches a module by an interface of its own that extends `FrameContext`, so a module
   takes no more than it declares and the platform names nothing of a module.
4. **No wire change.** The operations moved with the same acknowledgements, errors, refIds and order: the suites of the router
   are unchanged but for the line that gives the router chat's handlers, and the load harness (`budget:latency`) is the same
   before and after (numbers in the pull requests).

**Built in steps.** The field, the dispatch and `MESSAGE_SEND` and `TYPING` first; then `SUBSCRIBE`, `UNSUBSCRIBE`, the replay of
channel messages and the answer to a refused subscription, after which `realtime/router.ts` leaves `ALLOWED` in
`module-seams.test.ts`. Authorising a topic stays chat's, with the operation: `SUBSCRIBE` names channels in the contract, and
a topic prefix with an `authorise` hook would be a seam with one user (and `Topic` does not yet open to a module's own, §4).
What is not done: a module's own operation names (`ClientFrame` is a closed union in `@purlay/types`, so a third module still
adds its operation to the contract; the wire-unions step of `MODULES.md` §10 opens it).

**Rejected.** *Handlers in the manifest*: it makes `module-kit` import the platform's context. *A generic services bag in the
context* (push, typing, whatever a module needs): a module could take anything, and the platform would carry what one module
uses. *A topic-authorisation hook per prefix now*: see above. *The router asking each module to claim a frame*: ownership is
already the manifest's `frames`, checked against the core's claims by the registry.

**Cost of reversing.** Move the handlers back into the router's switch and delete the field; no stored data and no wire change.
