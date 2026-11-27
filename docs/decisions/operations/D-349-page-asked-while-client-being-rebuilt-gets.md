# D-349. A page asked for while the client is being rebuilt gets a short self-refreshing 503, and the demo confirms what its readers need

**Decided (the owner, 2026-11-26).** During the design audit (D-346) a settings page once rendered the API's JSON error
envelope as the page, and the access page of the demo always said it could not refresh. Both were traced:

- The API serves the client's build from `apps/web/dist`. A rebuild empties that directory for a moment; a navigation
  arriving then found no `index.html`, the `stat` threw `ENOENT`, and the error became a 500 with the JSON envelope,
  which the browser showed as the page.
- The demo (`scripts/demo.ts`) starts the API without `WORKSPACE_PROVISIONING_READY`, whose default is off (D-311), so
  the access page's reads answered that provisioning is not ready, and the page showed it as a failure to refresh.

**What changed.**

- A page navigation to a build without its shell gets a small 503 HTML document that refreshes itself without a script
  (`Retry-After: 2`, `no-store`, the document's own security headers). A path for an asset, or any path with an
  extension, and every API path still answer 404 in JSON: an old chunk is never served as a page. Only `ENOENT` and
  `ENOTDIR` mean "not there"; any other error from the file system is still a 500.
- The demo, a single-version sandbox in one process, gives the API the readiness confirmations its readers need
  (`WORKSPACE_PROVISIONING_READY`, and the others the end-to-end suite already sets). The API's default stays off.
- The access page says plainly that access management is not turned on on the server, and what an operator does,
  instead of offering a Retry that cannot succeed.

**Rejected.**

- Keeping the shell in memory from the start: during a replacement the old hashed assets are gone already, and it
  would hide a new deploy.
- Treating every file-system error under `dist` as "not found": it would hide a real fault as a missing page.
- Turning the readiness default on, or loosening the access read's gate: the default is off for a reason (D-311), and
  only the demo knows it is a sandbox.

**Cost of reversing.** Low: one function in the client-serving route with its tests, two lines of the demo's
environment, and one state of the access page.
