# D-280. A module's HTTP is its folder: `features/<id>/http/` holds its handlers and its routes as one plugin, and the application uses every bundled module's plugin in one place — builds on D-250, D-254, D-255, D-276; amends `MODULES.md` §2, §3, §8 and §9

**Context.** Chat's frames, jobs, data hooks and web UI were in its folder, but its HTTP was not: twenty-two files of
`ingress/http/` were its handlers, `app.ts` registered each of its routes by hand in one chain of two thousand lines, and
`module-seams.test.ts` allowed each of those files to import chat (27 entries). Issues, the smaller module, did the same
with one file. The audit called it the largest gap in the module structure: a module could not be read, or removed, as one
folder, and a third module would have added its handlers to the core's door.

**Decision.**

1. **A module's HTTP is a folder of the module.** `features/<id>/http/` holds the handlers (functions of a context and a
   `Request`, as the core's are) and `routes.ts`, one function from the module's context to an Elysia plugin that registers
   the routes at the paths of its manifest's `routes`. The manifest stays the truth about who owns a path: it holds no HTTP
   type and the plugin holds none of the ownership.
2. **The plugin is a field of the module's slot in `bundledModules`, `routes`**, beside `jobWork` and `frameHandlers` (D-276),
   for the same reason: the manifest is strings and types that `module-kit` carries without the framework. `createApp` makes
   the plugin of every **bundled** module, whether or not it runs, and uses them in one call (`.use(moduleRoutes)`); it names
   no module and registers none of a module's paths. A module that is not run is closed by its manifest at the edge, as
   before (D-255 §2), so the route table is the same in every process.
3. **The context is `ModuleRouteDependencies`** (`ingress/http/module-routes.ts`): what a module's routes use, named, and widened in
   a line a reviewer reads when a module needs more. Not the application's whole `Dependencies`, the services bag D-276 rejected
   for frames.
4. **The one typed chain, and what it was for.** D-255 §2 said the route table is one typed chain because its type is what
   the web client reads. Nothing reads it: `createApp` returns `HttpApplication`, which names `handle`, `listen`, `stop`,
   `held`, `drain` and `settled` only, the web imports nothing from `apps/api`, and the client's types are the contract's
   (`@purlay/types`, D-192). A plugin keeps the inference that matters, of a handler's `params` and `body` against its own
   path, and the aggregate type nobody consumes is `AnyElysia` at the seam. The hooks of the application (`onRequest`,
   `onBeforeHandle`, `onError`, `wrap`) are the chain's and apply to a plugin used after them: every suite that asserts an
   envelope, a header, a status, a deadline or a closed path passes unchanged, and the contract bundle is byte-identical.
5. **The fence.** `features/<id>/http/` may import Elysia and the door's helpers (`ingress/http/session`, `validate`), which the
   rest of a feature may not (`NO_TRANSPORT_TYPES`); it may not import the socket door, `ingress/http/app` or the composition,
   and, like the rest of the feature, no other feature. Its tests stand the application up and are kept from no transport.
6. **The guard.** `route-ownership.test.ts` reads the paths of `app.ts` and of every module's `http/` folder, and fails when a
   module that has routes supplies none and is not in `HTTP_IN_INGRESS` (a list that only shrinks, chat's name while its
   handlers are in `ingress/`), when `app.ts` registers a path of a module that supplies them, when a plugin registers a
   path its manifest does not own, and when the plugin and its folder's text disagree. `module-seams.test.ts`'s `ALLOWED`
   shrinks by each handler file that moves, and its cap with it.
7. **A route about a module's feature is the module's, whatever its path.** `GET` and `PUT /api/me/missed-mail` were the core's
   (`CORE_ROUTES`) over chat's service, so `ingress/http/missed-mail.ts` stayed a door that imported chat. They are a chat
   feature (the setting of chat's letter, D-240), so they moved into `features/chat/http/missed-mail.ts` beside the stop
   link, are listed in chat's manifest and left `CORE_ROUTES`. The public URL, the request and response shapes and the
   behaviour with chat run are unchanged (the contract bundle is byte-identical); in a process without chat they answer the
   `404 ROUTE_NOT_FOUND` of any unknown path (D-250), as every chat route does, and run in chat's share, under its deadline and
   with the `module` label `chat`. The setting is on the Notifications page, a settings section of chat's manifest, so the web offers it only where chat runs and no
   client asks for the closed path.
   `ALLOWED` shrinks to three doors and its cap with it; `module-seams.test.ts` names them, so a door re-added for a
   module's route fails there.

**Built.** The seam, the fence, the guard and issues' four routes first (#1159); then chat's handlers in batches, each a `git mv`
and a rewrite of imports proved by a script that compares every moved file with its base once each import specifier is replaced
by the file it resolves to (#1164 and the ones after it), until `app.ts` registered none of a module's paths. Chat's 97 routes are
in `features/chat/http/`, one file per resource, joined in `routes.ts`; what its GitHub-facing resources share is made once in
`wiring.ts` from the context, which gained the named fields they need (the application's configuration, the cipher, the limiter
factory, the App's settings, API and addresses, the node's presence record). `module-seams.test.ts`'s `ALLOWED` went from 27 to 3
(from 4 once `missed-mail.ts` moved, item 7), the real remainder of the core's doors: `releases.ts`, the socket's presence and
`erase-content`. The ownership test's `HTTP_IN_INGRESS` list,
which held chat while it moved, is gone: a module that has routes supplies a plugin, with no exception. The workspace's GitHub
token (`/api/workspaces/:workspaceId/integrations/github`) was chat's by its manifest and served by a core file that imported chat;
its handlers moved into chat's folder and `workspaces.ts` left `ALLOWED`. What is not done: a module's own error codes and wire
types still go through `@purlay/types`.

**Rejected.** *Each module's plugin hand-registered in `app.ts`* (`.use(issuesRoutes(...))`, `.use(chatRoutes(...))`): the
application would name every module and a third would edit the core's door. *Handlers in the manifest*: it makes `module-kit`
import the framework. *Registering routes only for the modules that run*: D-255 §2 chose the same table everywhere, and a
route table that depends on the process is a second thing to test in every cell. *A route-registration function that takes
the chain* (`(app) => app.get(...)`): Elysia's type is invariant in its routes, so the function cannot be typed without
`any`. *Moving the handlers and leaving the registration in `app.ts`*: the module's paths would still be written in the core.

**Cost of reversing.** Move a module's handlers back to `ingress/http/`, write its routes into the chain and delete the slot
and the fence; no stored data and no wire change.
