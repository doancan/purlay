# Spike — what Tailwind lets through, and what an icon costs

**2026-10-10.** Run before `packages/tokens` was written, because D-52 promised "a raw value is a
lint error" and nobody had asked what Tailwind builds when told only the tokens. Tailwind 4.3.3
(its `compile` API, driven by hand in a scratch directory), Vite 8.3.3, React 19.3.0,
`lucide-react` 1.48.0, `@tabler/icons-react` 3.48.0. Both icon versions are more than two weeks
old on the day they were chosen.

## Verdict

**Replace Tailwind's theme with the tokens, then check Tailwind's output, not just the syntax.**
Dropping the default theme makes every palette, spacing, radius, shadow and type class that is not
a token build to nothing. It does **not** stop Tailwind building a class from a bare number or an
arbitrary value; those are not theme-bound.

## What was measured

Each class below was built alone against three stylesheets: **A** the default theme plus two
tokens, **B** the default theme reset with `initial` and then our tokens, **D** *no default theme
imported at all*, only our tokens. "Builds" means the compiled CSS had a rule for it.

| Class | A: default + tokens | B: reset + tokens | D: tokens only |
|---|---|---|---|
| `bg-red-500` | builds | nothing | nothing |
| `p-7`, `w-64`, `text-sm`, `rounded-lg`, `shadow-md`, `font-bold` | builds | nothing | nothing |
| `bg-surface-100`, `p-4`, `text-body`, `rounded-md` (tokens) | builds | builds | builds |
| `z-50` | builds | **builds** | **builds** |
| `duration-300` | builds | **builds** | **builds** |
| `border`, `border-2`, `outline-2`, `opacity-50` | builds | **builds** | **builds** |
| `p-[13px]`, `w-[13px]`, `bg-[#fff]` | builds | **builds** | **builds** |
| `inset-0`, `p-0` | builds | nothing | **nothing** (there is no multiplier) |

Reset lists are a maintenance burden and incomplete by construction (B has to name every namespace);
**D is simpler and stronger**, so the stylesheet imports `preflight` and `utilities` and never
`theme`. Its side effect — `p-0` does not exist, because spacing is named steps and not a
multiplier — is why the scale has a `space-0`.

## Theme namespaces, which decide which utilities a token creates

| Token | Namespace used | Utilities |
|---|---|---|
| colour | `--color-*` | `bg-`, `text-`, `border-`, `outline-`, `fill-` … |
| spacing | `--spacing-*` | `p-`, `m-`, `gap-`, `inset-`, `size-` … (named steps only) |
| widths of regions | `--container-*` | `w-`, `min-w-`, `max-w-` |
| square sizes | `--size-*` | `size-` only |
| stacking | `--z-index-*` | `z-` |
| duration | `--transition-duration-*` | `duration-` |
| easing | `--ease-*` | `ease-` |
| stroke widths | `--border-width-*`, `--outline-width-*` | `border-`, `outline-` |
| viewport width | `--breakpoint-*` | the `narrow:` and `max-narrow:` variants — **a literal**: a media query cannot read a variable |

`@theme inline` makes utilities emit `var(--surface-100)` themselves, which is what lets
`<html data-theme>` change them at runtime; without `inline` the theme would capture the value at build
time.

## Things that did not work the way the documentation suggests

- **`--text-<name>--font-family` is not a thing.** `--text-code--line-height`, `--font-weight` and
  `--letter-spacing` are read; the family is silently ignored. A type style is therefore an
  `@utility` that sets all five properties, and a style carries its own family.
- **An opacity modifier is a literal.** `bg-ink/50` builds to `color-mix(in oklab, var(--ink) 50%,
  transparent)`. The 50% is an unnamed decision, so the output check refuses `color-mix`.
- **A build that matches nothing leaves `@layer utilities;`** with no body, not an empty block. The
  first version of the checker looked for the first `{` after it and judged the wrong rule.
- **Tailwind's own scanner is for building, not for judging.** It reported 942 candidates in
  `apps/web/src`, taken from every word of every comment ("border", "shadow"). Judged as classes
  they would be false findings, so classes are read with the TypeScript parser from the places that
  are for them.
- **A bare `border` is `border-width: 1px`.** It is a literal; the output check refuses it and the
  token is `border-hairline`.
- **Preflight's own `1em`, `0.25em` and `20px`** sit in the base layer, not in utilities, and are the
  library's; only the utilities layer is judged.

## Icons: two candidates, one production build each

Six, then twelve icons imported by name into an otherwise empty React page, `vite build`; gzip of the
one JavaScript chunk, against a base of 68.28 KB.

| | 6 icons | 12 icons | per added icon | files in the package |
|---|---|---|---|---|
| `lucide-react` | +1.85 KB | +2.36 KB | ~0.085 KB | 4,236 |
| `@tabler/icons-react` | +0.74 KB | +1.18 KB | ~0.073 KB | 12,442 |

The marginal cost is the same; the difference is a fixed base of about 1.2 KB. The pre-bundled
dependency Vite's dev server serves: **1.5 MB** for Lucide, **4.4 MB** for Tabler. Both declare
`sideEffects: false` and tree-shake. Licences: ISC and MIT. Chosen: Lucide (D-97).

Not measured: Phosphor, an in-repository set of hand-copied paths, and cold dev-server start time
(the 1.5 MB / 4.4 MB figures are the size of what is served, not a stopwatch).

## What had to be loosened

**Nothing.** No lint rule, compiler flag or budget changed. `lucide-react` and `tailwindcss` (as a
dev dependency of the tokens package, for the vocabulary test) enter the manifests; both are pinned
exactly.

## What surprised us

- **The contrast gate found a bug on its first run.** The design system's `border-strong` is 2.85:1
  against `accent-subtle` (a mention row) in the dark theme; its own note said 3:1.
- **A second component test broke the first harness.** `testing/dom.ts` registered its hooks when
  the module was imported; a module is imported once, so the second test file had no DOM. Invisible
  while one component test existed.
- **The scale needed a zero.** With no multiplier, `p-0`, `m-0` and `inset-0` exist only if
  `space-0` does.

## Not run

- Tailwind's behaviour under the Vite plugin in dev mode with HMR; the production build and the
  `compile` API were used, and `bun run build:web` passes.
- Light theme in a real browser: the generated CSS and the contrast of both themes are checked; no
  one has looked at a screen in the light theme, and none exists yet.
