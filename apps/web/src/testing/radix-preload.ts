/**
 * Makes Radix work in a test DOM that is registered after Radix is imported.
 *
 * `@radix-ui/react-use-layout-effect` decides, **when it is imported**, whether a
 * DOM exists:
 *
 * ```js
 * var useLayoutEffect = globalThis?.document ? React.useLayoutEffect : () => {};
 * ```
 *
 * A component test registers its DOM in a lifecycle hook (`testing/dom.ts`), which
 * is necessarily after the file's imports — so Radix always imports without one,
 * gets the no-op, and its `Portal` (which mounts in a layout effect) never mounts:
 * a dialog, a menu or a tooltip reports `data-state="open"` and nothing is ever
 * drawn. Found by rendering Radix's own `Tooltip` with `defaultOpen`; nothing else
 * in the tree was wrong.
 *
 * Replacing the one hook with React's own — what Radix picks in a browser —
 * has to happen **before the module graph is loaded**: `mock.module` from a test
 * or a helper file reaches only imports made after it, and a static import is
 * already bound by then. So this is a preload, and it is the only thing about it:
 * it installs no DOM and no global, and touches nothing the API, database or
 * script suites can see. (The earlier objection to a preload was a DOM in every
 * test, `testing/dom.ts`; this is not that.)
 *
 * Listed in `bunfig.toml`. The package is a direct devDependency of `apps/web` only
 * so this file can name it.
 */
import { mock } from 'bun:test';
import { useLayoutEffect } from 'react';

await mock.module('@radix-ui/react-use-layout-effect', () => ({ useLayoutEffect }));
