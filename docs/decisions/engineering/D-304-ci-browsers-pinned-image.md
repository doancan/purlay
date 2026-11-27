# D-304. CI starts browsers from their pinned image instead of installing system packages in every job — builds on D-203, D-227

**Context.** Two different PR heads failed before browser tests: all Chromium and WebKit jobs exhausted
three bounded dependency installs because both Ubuntu mirrors failed DNS resolution (#1402). Reordering
mirrors would not address both failures. The actual Linux spike and its unchanged visual/download checks
are recorded in `docs/spikes/ci-browser-container.md`.

**Decision.** Both hosted browser jobs use a shared local composite action. The official Playwright image
is pinned by a multi-architecture digest and must match the frozen client version before Docker starts.
Only browsers run inside it. Bun, the API, database, test workers and budget commands keep running on the
hosted runner. The checkout is mounted read-only; no token or application environment is passed into the
container. Direct Linux host networking lets the browser reach the unchanged localhost servers without a
proxy; the browser server listens only on loopback. No production image or configuration changes.

Startup records only a valid Docker id for cleanup, waits a bounded interval for readiness and verifies
its own container is still running before publishing the test endpoint. Every job removes only its own
recorded id even after failure. A version mismatch, start failure, readiness failure or exited server fails
the job. The image includes browser system libraries and fonts; developer native installation remains
available. See the [official container guidance](https://playwright.dev/docs/docker).

Existing test commands, engine/theme/width matrix, WebKit policy, Linux screenshot goldens, zero retries,
measurement isolation, performance bounds and required gate remain unchanged. Changes to the local action
run the browser jobs. Image/client upgrades must move together and pass those checks; no baseline refresh
or weaker threshold is part of this change.

**Proof.** The real Linux host-network spike passed 56 cases with 4 existing engine/project skips,
including unchanged Chromium visual goldens, WebKit CSV download, WebSocket archive/reconnect and Chromium
push-worker/CDP operations. Lifecycle tests execute the actual action shell with controlled Docker/network
failures, and mutations remove its new guards. Full hosted CI remains the release authority, including
performance: the local spike does not claim a hosted performance result.

**Rejected.** Unchanged job retries; mirror reordering after both failed; larger install/test timeouts;
skipping browser checks; running the whole application in the browser image; a floating image tag; a
loopback forwarding proxy, whose WebKit download stalled in a Mac-only prototype; new visual baselines.

**Cost of reversing.** Restore the existing native browser installer steps. Keep all test commands and
checks. There is no migration, persistent service or production rollback action.
