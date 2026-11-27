# D-97. Visual values are tokens in one file; the vocabulary is generated and the build judges it

D-52 said a raw value in a component is a lint error, and `UX.md` §9 listed the values in prose.
Nothing turned either into code with one owner (#137). The first question was whether Tailwind's
theme alone could enforce it, and the spike (`docs/spikes/design-tokens.md`) measured that it
cannot: with the default theme replaced by our tokens, `bg-red-500`, `p-7`, `rounded-lg` and
`text-sm` stop existing — and `z-50`, `duration-300`, `border-2`, `w-[13px]` and `bg-[#fff]` keep
building, because Tailwind makes them from a bare number or an arbitrary value whatever the theme
says. Lint alone is no better: it sees syntax, and `z-50` is ordinary syntax.

**Decided: one source, a generated vocabulary, and three independent refusals.**

**1 · One source.** `packages/tokens/tokens.json` holds every colour in every theme, the spacing,
radius, shadow, size, stacking, stroke, duration and easing scales, and the type styles. The file is
shaped so the design system it came from can still read it; **this repository owns it** from now on
and the design system is re-synced from it, not the reverse. The schema is stricter than the design
tool's: unknown keys are refused, a colour must be written in every theme (a theme never inherits —
inheritance is how a light theme ships with one dark panel), a spacing step must sit on the 4px grid,
there is no weight above 600, no motion over 200ms, and no font file (the stack is the system's own).

**2 · Generated, committed, checked.** `bun run tokens:generate` writes `tokens.css` (custom
properties, no framework), `theme.css` (the Tailwind binding) and `names.ts` (the names as types).
They are committed so they can be read, and `bun run tokens:check` — in `verify` and in CI — fails if
they differ from what the source would produce, the same shape as `.env.example` and the database types
(D-45). Light is declared after dark so the later block wins on `<html data-theme>`; every motion
token is `0ms` under `prefers-reduced-motion`.

**3 · Tailwind's default theme is never imported.** The stylesheet takes `preflight` and `utilities`
and the generated `theme.css`, so the vocabulary is exactly the tokens. `@theme inline` keeps
utilities pointing at the custom properties, which is what lets the theme change at runtime. A type
style is one `@utility` that sets family, size, leading, weight and tracking together, because the
theme namespace has no key for a style's family.

**4 · Three layers refuse a raw value, each seeing what the others cannot.**
- *The file* (`parseTokens`): shape, grid, weights, motion, themes, aliases.
- *Syntax* (`purlay/no-raw-visual-value`, lint): an arbitrary Tailwind value or property, a string that
  is a colour or a length, a literal in a `style` object, a numeric `width`/`height`/`strokeWidth`, a
  class list assembled with `${}`. Demonstrated in `verify-enforcement`.
- *Tailwind's own output* (`styles.test.ts`): every class the application writes is compiled against
  the real stylesheet, and fails if it builds to nothing (a typo, a palette class) or to a raw value
  (`z-50`). Classes are found with the TypeScript parser in the places that are *for* classes —
  `className`, `cn`/`clsx`/`cva`, and a variable named `…Classes` — because Tailwind's own scanner
  takes every word of every comment for a class.

**5 · Contrast is arithmetic, and complete.** `pairs.ts` states which colour must be readable on which
(4.5:1 for text, 3:1 for a control's edge and the focus ring) and the build computes it in every theme.
Every colour must be in a pair or in `EXEMPT` with a reason, so a colour added without deciding what it
must be readable against fails. The usage notes carry no figure: a number in prose is a second copy.
The first run found a real defect in the design system's seed — `border-strong` was 2.85:1 on a
mention row in the dark theme, below the 3:1 the notes claimed — and it is fixed in the file.

**6 · Icons: `lucide-react`, behind one component.** `components/icon.tsx` is the only importer
(lint), the vocabulary is `glyphs` — a screen asks for `channel`, not `Hash` — the size is one of
three `size-icon-*` tokens that sit beside the caption, body and title styles, and the one weight is
the `stroke-icon` token (2.25 units on the 24-unit grid, which is 1.5px at 16px). `Icon` accepts no
pixel size and no stroke width, so there is no second weight to ask for. Measured against
`@tabler/icons-react` with twelve icons in a production build: Lucide +2.4 KB gzipped, Tabler +1.2 KB;
the marginal cost per icon is the same, ~0.08 KB, so the gap is a fixed base of about 1.2 KB. In
Vite's dev server the pre-bundled barrel is 1.5 MB for Lucide and 4.4 MB for Tabler. Both are
`sideEffects: false`; Lucide is ISC, Tabler MIT. **Chosen: Lucide**, accepting about 1.2 KB of the
250 KB budget for the smaller catalogue to audit and the lighter dev server.

**7 · The measurements of the approved prototype are tokens, found by running the rule on the
prototype.** The first screens were drawn as a prototype and approved before any component existed
(`UX.md` is the behaviour, `tokens.json` the values). Running this decision's own rule over that
prototype found five lengths with no token — the height of a control (28px), of the channel header
(48px), the timestamp column of a message row (56px), a mention badge (18px) and a presence dot (8px)
— and each became a `size-*` token rather than a literal, bound to the utility that reads it
(`h-control`, `h-header`, `w-gutter`, `h-badge`/`min-w-badge`, `size-dot`) because `--height-*` is the
namespace Tailwind reads for `h-` and `--container-*` the one for widths, measured and not assumed. A
badge is bound twice, as a height and as a minimum width: one digit is a circle and two are not. The
prototype also drops the 56px workspace rail for a switcher in the sidebar header, which `UX.md` §2
still draws; `size-rail` stays until that section is rewritten with the screens. D-110 brings the rail back,
holding only destinations that already exist.

**8 · Amended 2026-10-10: a name shared by a theme key and a token is a utility, not a key.** The
first screens in a real browser showed a serif font, 24px icons and square corners: Tailwind writes
every theme key to `:root` even under `inline`, so `--radius-md: var(--radius-md)` was written after
the token's own `--radius-md: 6px`, won, and — a custom property that refers to itself being invalid —
the radius, the icon size and the whole font stack fell back to the browser's. Every test that
compiled classes passed, because none ran a cascade. The generator now refuses such a key and writes
the utility that reads the token (`rounded-*`, `size-*`, `shadow-*`, `font-*`); `radius-full` became
`radius-pill`, because Tailwind's own `rounded-full` is a static utility the generated one would
have sat beside; and `e2e/tokens.e2e.ts` reads the computed values in a browser, in both themes.

**Rejected — Tailwind's theme plus lint alone.** Measured above: it cannot see `z-50`, and a typo
builds to nothing silently.

**Not adopted, and not evaluated — Style Dictionary.** A generic token transformer; the three
checks that matter here (readable contrast, a complete decision for every colour, a vocabulary check
against Tailwind's output) would have been written either way, and it adds a build dependency and a
configuration for the transform we do in under 300 lines. A rejection on cost and not on a
measurement, and it is recorded as one.

**Not adopted, and not evaluated — the ESLint plugins for Tailwind.** The changelog said a spike was
owed to find out which of them refuses an arbitrary value before either entered the stack. None
enters, so nothing is owed: they judge class names as text, and the question this needed answered is
what Tailwind *builds*.

**Rejected — a second weight, or a pixel size, on `Icon`.** The point of the component is that they
cannot be asked for.

**Reopened when** a web font is wanted (the schema forbids one: adding it is a decision and a budget
line), a transition longer than 200ms is wanted, Tailwind changes what `@theme inline` or the
`--text-*` namespace means (the vocabulary test fails first), or a second theme beyond dark and light.

**Reversibility:** the values are free to change. The *shape* — one file, generated outputs, the
refusals — is cheap to keep and costly to add later, which is why it is built before the first screen.
