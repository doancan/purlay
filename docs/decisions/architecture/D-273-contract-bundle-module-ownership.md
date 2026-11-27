# D-273. The contract bundle says which module owns each endpoint, event and operation, and lists the modules — builds on D-190, D-192, D-250, D-255; answers D-250 open question (b) for the bundle

**Context.** `contract:bundle` (D-192) carried nothing of the module structure: no list of modules, no owner on an endpoint, an
event or an operation, and `MeResponse.modules` was a free `string[]`. The macOS application (#958) has to draw only the modules
a server runs, ask nothing of one that is off and ignore one it does not know; from the bundle alone it could do none of that
without a hand copy of which route, frame and event is chat's, which is the second home D-192 exists to prevent.

**Decided.**

1. **`contract.json` gains four things, all derived.** `modules` (each module the build carries: `id`, `requires`, `optional`, the
   `routes` templates, the client `frames`, the server `events` and the `notificationTypes` it owns, every list sorted);
   `module` on each entry of `endpoints`; `eventOwners` and `frameOwners` (every server event and every client operation of the
   contract, by name, with its owner). An owner is `core` or a module id. They are read from each manifest and from the core's
   claims (`CORE_CLAIMS`, `ownersOf`), the same maps the server closes a module's routes, frames and events by
   (`apps/api/src/contract/module-structure.ts`), with no list of the bundle's: an endpoint, an event or an operation that
   neither the core nor a manifest claims fails the bundle's build, and so does a module called `core`.
2. **`MeResponse.modules` is `ModuleId[]`**, `ModuleId` being the union of the ids the build carries, written once in
   `@purlay/types` (`modules.ts`) because that package cannot read the registry. Two things hold it to the registry: a test
   fails when a manifest id is missing from it (or it names one the build lacks), and `assembleBundle` throws on the same
   difference, so a release cannot be made with a stale type. The server stops at boot on a running module whose id is not a
   `ModuleId`. The values on the wire are the strings they were: a client built from an earlier bundle reads them as strings.
3. **Not a bump.** `CONTRACT_VERSION` stays (D-190: responses may gain fields, a union may gain a member the client treats as
   unknown) and so does `CONTRACT_BUNDLE_FORMAT` (a key was added to `contract.json`; a generator that ignores keys it does not
   know reads the old layout's every field unchanged). `contract:bundle` before and after differs in `contract.json` by those
   keys and by the `ModuleId` reference under `MeResponse.modules`, and in `docs/` by this text.
4. **A module that is off is absent from `MeResponse.modules`**, and that list is the only way to know. Its routes answer the
   plain `404 ROUTE_NOT_FOUND` of any unknown path and its socket operations the `VALIDATION_FAILED` for `op` (D-255 §2). No
   public capability says it before sign-in: D-255 §5 rejected naming modules in the public handshake, and the three
   `capabilities` flags that already follow chat stay as they are. `API.md` §2 tells a client author this, and to ignore an id
   it does not know.
5. **Wire names stay.** Namespacing frame types (`chat.message.created`, D-250 open question (b)) is not done: the owner maps
   give a client the grouping without renaming anything, so there is nothing installed clients would have to alias. Whether the
   native client drops an unknown frame rather than disconnecting is still not checked in this repository; #958 asks for it.

**Rejected.** *Namespaced frame and event names*: a break for installed clients, to give what a map gives. *A split of
`ServerFrame` into a core part and one per module*: one union in the contract with an owner map says the same, and a generator
need not learn a second shape. *Listing modules in `GET /api/client`*: D-255 §5. *A hand-written list of owners in the bundle*:
it would go stale without a sound. *A closed `ModuleId` that a client fails on*: the contract's convention (`bundle` README) is
that a union may gain a member and a client ignores it, and `API.md` says so for this one.

**Accepted.** `ModuleId` is spelled by hand beside the registry and held to it by a test and by the bundle's build, as
`PRODUCT_MODULE_REQUIRES` is held to the manifests. `Topic` is a string template and not a schema, so it is not in the bundle:
a client takes a topic from the server, never builds one. The issues module's four routes were not in `ENDPOINTS`; they are now
(`listIssues`, `createIssue`, `updateIssue`, `deleteIssue`), owned by `issues`, so a client sees them as the module's and
draws or asks for none of them where it is off.

**Reverses if** the application is built in this repository (D-192's reversal): the owner maps are then read from the code.
**Cost of reversing.** Cheap: remove the keys and the `ModuleId` reference; nothing is stored.
