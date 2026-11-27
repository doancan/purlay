# D-113. The browsers the client supports, and what holds the line

Nothing recorded which browsers the web client supports; the client already relied on
`URL.canParse` and regular-expression lookbehind, so a floor existed by accident (#331). Served by
#331; decided in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided: the last two years of the evergreen engines** — Chrome and Edge 120, Firefox 121, Safari
and iOS Safari 17.2 — named once, as `browserslist` in `apps/web/package.json`.

**Held three ways, because the spike showed each sees only part** (`eslint-plugin-compat` 7.0.2,
run on 2026-10-12 against probes):
1. **`compat/compat` in lint**, reading that list: a constructor or global one of them lacks fails
   (`new URLPattern` was refused for Safari 17.2 and Firefox 121; `structuredClone` and
   `IntersectionObserver` passed). It does **not** see static methods — `URL.canParse` and
   `Promise.withResolvers` passed even against Safari 12 — and its data lacks some APIs
   (`CloseWatcher` passed though Safari has none).
2. **`lib: ES2023`** in the client's TypeScript project: an ES2024 built-in fails to compile
   (`Object.groupBy` did). Bun's own types, which the project includes for its tests, re-add some
   (`Promise.withResolvers` compiled) — the gap that is left.
3. **`build.target`**, derived from the same list in `vite.config.ts`: syntax the targets lack is
   lowered for them.

**Accepted, stated:** a static method on a web or ES object that Bun's types declare, and an API
missing from the compat data, still pass all three. Closing that needs the client's sources
typechecked without Bun's types — a separate project for the tests — which is its own change.
Nothing was loosened to make this work. The browser suite still runs Chromium alone (D-52).

**Rejected: a hand-kept list of APIs with their minimum versions.** It would be wrong the first
time a browser shipped one; the compat data is maintained by the people who measure it.
