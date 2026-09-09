/**
 * A DOM, for component tests only.
 *
 * `happy-dom` alone does not give one: rendering fails with
 * `ReferenceError: document is not defined` until its global registrator has
 * run. The stack table named only the first half (`docs/spikes/web-client.md`).
 *
 * Registered by a side-effect import here rather than by a `bunfig.toml`
 * preload, which would install a DOM into **every** test in the repository —
 * including the API and database suites, which have no business having one. A
 * module evaluates in import order, so a component test imports this above
 * anything that touches `document`. The same pattern as `@purlay/types`
 * registering its string formats.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

/**
 * **The global `screen` does not work with this, and lint refuses it.**
 *
 * `@testing-library/dom` decides at *its own module evaluation* whether a global
 * document exists, and binds `screen` to `document.body` or to a set of throwing
 * stubs accordingly. That happens before this module runs, despite the import
 * order in the file — measured, not reasoned about:
 *
 * ```
 * [probe] document.body = <body></body>
 * [probe] screen.getByRole is function
 * [probe] render queries work: hi
 * [probe] screen threw: For queries bound to document.body a global document has to…
 * ```
 *
 * A `bunfig.toml` preload would fix it, at the price of installing a DOM into
 * **every** test in the repository — including the API and database suites,
 * where a dependency that feature-detects `window` would quietly take its
 * browser path. A silent behaviour change in server code, caused by a test
 * harness, is a worse trade than an unavailable convenience.
 *
 * So component tests use the queries `render` returns. They are scoped to what
 * the test rendered rather than to the whole document, which is the better habit
 * anyway, and `within(element)` covers the rest.
 */
