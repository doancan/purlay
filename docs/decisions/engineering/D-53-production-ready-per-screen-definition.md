# D-53. "Production-ready" is a per-screen definition of done, not a phase

The requirement was stated directly: no output that feels like a prototype, production quality from
the beginning. Read as scope that would contradict D-4's phasing and sink the project. Read
correctly it is a **quality bar per unit of work**: phase order decides *what* ships, this decides
*what shipping means*.

`UX.md` §8 already says it — *"an unhandled empty state is an incomplete feature, not a polish
item"* — and nothing checked it. Prototype feel has specific, mechanical causes, so each gets a
mechanism rather than an intention:

| What makes it feel unfinished | What prevents it |
|---|---|
| Default browser styling on form controls | Tokens and primitives; a raw value is a lint error (D-52) |
| Inconsistent spacing and type sizes | One scale, no arbitrary values |
| Missing loading, empty or error states | A test per screen asserting all four states render (`UX.md` §8) |
| Invisible or default focus ring | `axe` plus the keyboard-path test; `outline: none` is a lint error |
| Animation that is arbitrary or absent | Duration and easing are tokens; `UX.md` §9 keeps motion near zero |
| Text that overflows or truncates badly | Visual snapshots at narrow and wide widths |
| Icons of mixed weight and size | One icon set, one weight, sized from the type scale |
| A screen that only works in one theme | Snapshots in **every theme that exists** — one until light arrives in Phase 2 (`UX.md` §9), both after |

**No screen is merged with a state unhandled.** Not "styled later" — `UX.md` §8 names the empty,
loading and error state for every view already, so a screen missing one is missing specified
behaviour, not polish.

**What this does not mean.** It does not mean building Phase 1 features during Phase 0. The walking
skeleton ships *few* screens; each is finished. A small excellent product is what the interface
exemplars in D-51 all are.
