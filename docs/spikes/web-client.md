# Spike — the web client stack

**2026-09-09.** React, Vite, Tailwind, a headless primitive, the two state libraries and the
component-test tooling, stood up together in a scratch directory against a byte-identical copy of
`packages/config/tsconfig.base.json` and the repository's lint configuration.

Every one of these was in `ARCHITECTURE.md` §2 and none had ever been installed.

## Verdict

| Gate | Result |
|---|---|
| Typecheck, TypeScript 7 | passes |
| Typecheck, TypeScript 6 API | passes |
| Lint | passes |
| Production build | passes |
| Dev server | serves, and Tailwind's classes are live — confirmed by computed styles in a real browser, not by the class attribute being present |
| Component test under `bun test` | passes, including clicking a headless primitive's trigger and asserting the portalled dialog |

Install was clean: no peer warnings, no `--force`, no overrides.

## What had to be loosened

**Nothing.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `composite`
and `declaration` all stayed on and all pass on `.tsx`. No lint rule downgraded, no `any`, no
cast, no suppression.

Verified with negative controls rather than assumed: an injected `any` and a missing return type
in a `.tsx` file produced the expected five lint errors, and a strict-flag probe produced identical
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` errors from **both** compilers. The
rules do bite `.tsx`.

## What it found in this repository

**`apps/web` compiled zero `.tsx` files and reported success** — `include` covered only `.ts` and
no `jsx` setting existed, while the linter was configured to read `.tsx`. Fixed, with a check that
compares the two file sets, in the change that closed it.

**Build-tool files at a package root belong to no project.** A `vite.config.ts` sits outside every
`include`, and `eslint .` reads it anyway, producing a parse error. It needs a project of its own.

## Configuration facts, observed

**Tailwind needs two things and no more:** its Vite plugin, and one line of CSS —
`@import 'tailwindcss'`. No config file, no PostCSS config, no `content` array; source detection
found every utility used, including the awkward ones. The emitted CSS is real rules, not stubs.

**`happy-dom` alone is not enough.** Rendering under `bun test` additionally needs
`@happy-dom/global-registrator` and a `bunfig.toml` preload; without it, `document is not defined`.
The stack table named only the first.

**`types` must be extended, not replaced.** The base pins `types: ["bun"]`, which suppresses
automatic inclusion — so a CSS side-effect import fails until `vite/client` is named explicitly.

## What building it for real then taught

**The measured skeleton is smaller than this spike's**, because this spike installed more than the
client needed. Built from `apps/web` with React, Tailwind and nothing else:

```
index.html   raw     391 B  ·  gzip     275 B
index.css    raw   5 582 B  ·  gzip   1 931 B
index.js     raw 190 730 B  ·  gzip  59 333 B
─────────────────────────────────────────────
                              gzip  61 539 B   ≈ 25% of the 250 KB budget
```

The difference from the number below is the server-state library, the store and one dialog
primitive — none of which the client needs yet, and each of which will arrive with the issue that
needs it. That is D-57's rule paying for itself: the spike answered the compatibility question
without the repository taking on the dependencies.

**The global `screen` does not work with a locally-registered DOM.**
`@testing-library/dom` decides at *its own* module evaluation whether a global document exists and
binds `screen` accordingly — before a side-effect import in the test file can register one, despite
the source order. Measured:

```
[probe] document.body = <body></body>
[probe] screen.getByRole is function
[probe] render queries work: hi
[probe] screen threw: For queries bound to document.body a global document has to…
```

This spike did not hit it because it used a `bunfig.toml` preload, which registers a DOM into
**every** test in the repository. The client uses the queries `render` returns instead, and lint
refuses the import.

**`bun x <tool>` from the wrong directory downloads `latest` and says nothing.** `bun x vite` at
the repository root fetched an unpinned Vite and built with it, because Vite is installed under
`apps/web`. A check now refuses a script that names a tool its own manifest does not install.

## The number that changes a budget

The skeleton — React, one query hook, one store, one dialog, no product code — builds to:

```
raw   263 096 B   ·   gzip  81 743 B
```

Against `PRD.md` §5's 250 KB gzipped budget that is **33% consumed before a single product screen
exists**. Attribution from the sourcemap:

| | share |
|---|---|
| `react-dom` | 68.2% |
| the server-state library | 11.8% |
| `react` | 3.0% |
| one dialog primitive, with its ten transitive packages | ~11% |
| application source | 0.5% |

Two consequences worth carrying forward: the budget is mostly spent on the framework rather than
on anything a feature adds, and **one headless primitive costs about 28 KB** — which is the
argument D-52 makes for importing them one at a time, now with a number attached.
