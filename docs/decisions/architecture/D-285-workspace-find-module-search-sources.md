# D-285. The workspace find asks each running module's search source at once, as that module and under a deadline, and answers a group for each source — builds on D-34, D-265, D-266, D-270, D-283; amends D-283 §4

*Amended by D-328: each group is cut at the limit and says `more`, and an answer missing a slow or failed source says `partial`.*

**Context.** D-283 §4 decided a core route `GET /api/workspaces/:workspaceId/find` that asks every running module's
`SearchSource`, and left four things to the step that builds it: what a source is handed, what holds its deadline, what the
answer says of a source that was not asked, and how issues is searched. The search of messages (`GET …/search`, chat's) answers
one source and has filters, saved searches and a cursor; it stays as it is. The find is the other question: where is this
word, in anything this workspace keeps.

**Decision.**

1. **A source is a port.** `SearchSource` (`platform/ports/search-source.ts`) is an id and one function from the application's
   database, the caller's `WorkspaceContext`, the words and a limit to at most that many hits, newest first. A module supplies its
   sources in the `searchSources` of its slot under the ids of its manifest's `searchSources`, and `compose` stops the build for an id
   with nothing behind it and for a source nobody listed. The source narrows by the caller and the workspace in its own query and
   never filters what it read (D-34): chat's is `searchIn` over the channels the caller can see, issues' is the workspace.
2. **Each source is asked as its own module.** `find` runs it inside that module's request scope, so its statements take the
   module's share of the pool (D-266) and none of the core's, and under the abort signal of its deadline, which cancels what it
   asked of the database when the deadline passes (D-270). The deadline is 1.5 seconds, or the module's own when that is shorter,
   and is a field of the application for a test to shorten. All the sources are asked at once and the answer waits for the slowest
   of them only up to that bound. There is **no deadline on the route as a whole**, which D-283 §4 put at three seconds: the
   sources run together, so the route is bounded by the deadline of one, and a second number would be one more thing to explain.
3. **The answer is a group for each source and a list of the sources it skipped.** `groups` are the sources that answered, each with
   its `source` id and up to ten `hits`, in the order of the composition; one that found nothing is a group with no hits.
   `skipped` is each source that did not, with the reason: `off`, its module is not run in this process and it was **not asked**
   (the owner's decision, D-283 §8.5: the signed-in session already says which modules run through `GET /api/me`); `slow`, it passed its
   deadline (D-283 §4 called this `timeout`; the owner chose `slow`); `error`, it threw, which is written to the log with its module
   and source and never to the caller. A source that is skipped never holds up the others' groups, and there is no one ranked list
   and no cursor, because a score does not compare across sources.
4. **The route is the core's.** It is in `CORE_ROUTES`, checks the workspace's membership outside every module's share, and answers
   with chat not run, which is the point of a search that is not chat's. The contract's types are additive (`FindQuery`,
   `FindResponse`) and `CONTRACT_VERSION` does not move; the bundle lists the endpoint under `core`. A person who is not in the
   workspace is told `WORKSPACE_NOT_FOUND`, as everywhere (`CONTRIBUTING.md` §1.2), and the cross-tenant matrix drives it as a read that spans channels.
5. **Issues is searched in two queries.** A title and a body, each on its own trigram index of `purlay_fold` of the column in a
   workspace (`issues/0002_issues_search.sql`, built `CONCURRENTLY` outside the migrator's transaction, as chat's are), merged under
   one order and cut to the limit, each issue once. Not one `OR`, which neither index serves (#1019). The words are at least three
   characters (`SEARCH_QUERY_MIN`) for the same reason.
6. **The find is charged to the person who asks** (an audit of 2026-11-08, red-team F7). One find is two trigram scans for each source
   under a deadline, and nothing but the write budget stood in front of it, which a read does not spend. `FIND_BUDGET` is a bucket of
   its own, by signed-in user and before the membership is read, so a workspace that does not exist costs what one does: twenty at once,
   then five a second, and a refusal is `429 RATE_LIMITED` with `Retry-After` like any. Provisional (O-4); it goes through the limiter
   every other route uses (`limiterFor`, so a cluster's shared Redis counts it once). A person's pause in typing is one find, not a key.

**What holds it.** `find.integration.test.ts` of the route, of the fan-out with a fake third module's source and of issues'
source; the cross-tenant and channel-visibility matrices; `compose` refusing a source and a manifest that disagree; and the mutations
that remove each guard (`MODULES.md` §8).

**Not built here.** The web's groups of results and the line for a skipped source (`MODULES.md` §10 step 14m), a metric of how long
each source took and how many were skipped, and a source's own cursor: a person who wants more of a source goes to its screen.

**Rejected.** *A deadline on the route as well*: see 2. *One ranked list*: D-283. *Asking the source of a module that is off and
hiding the answer*: a read of a table that is not there, or of data the operator turned off. *A signal passed to the source as an
argument*: it is in the request scope the share is already read from, and a second way to carry it could disagree with the first.

**Cost of reversing.** The route and its types are additive and may be removed with the web's use of them; the two indexes drop
with the module's set and cost nothing to the rest.
