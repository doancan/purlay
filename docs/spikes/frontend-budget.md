# Spike — what the frontend stack costs

**2026-09-09.** Every library `ARCHITECTURE.md` §2 names for the client, installed together and
built, to answer one question before any screen is written: **does the declared stack fit the
declared budget?**

`PRD.md` §5 caps the initial JS bundle at **250 KB gzipped**, and D-49 makes it one of the two
deterministic budgets that **block a merge**. A budget discovered to be unreachable after five
screens exist is a budget that gets raised.

## The numbers

| | gzip | share of 250 KB |
|---|---:|---:|
| The shell that ships today — React, Vite, Tailwind | 60 KB | 24% |
| **+ 4 Radix primitives + `cmdk` + TanStack Query + Zustand** | **108 KB** | **43%** |
| + `marked`, eagerly | 121 KB | 48% |
| + Shiki (JavaScript regex engine), eagerly | **173 KB** | **69%** |

**Sixty-nine per cent, with no product code.** That is the number that matters, and it is only
reachable because everything above was imported eagerly into one chunk.

## Splitting is not an optimisation here; it is the design

Moving the markdown and highlighting path behind a dynamic import puts it in its own chunk and
returns the initial bundle to **108 KB (43%)** — about **142 KB left** for the entire product.

| Lazily loaded | gzip |
|---|---:|
| `marked` | 12.8 KB |
| Shiki, JavaScript regex engine | 53.3 KB |
| Shiki, Oniguruma WASM engine | 36.0 KB **+ 232 KB of WASM** |

**The JavaScript engine wins, and not narrowly.** The WASM engine is smaller in JavaScript and
seven times larger in total; for a product where most messages contain no code block, paying 268 KB
to avoid 53 KB is the wrong trade. `ARCHITECTURE.md` §2 says *grammars* load lazily — the
measurement says the **engine** is the weight, and grammars are the smaller half of the sentence.

## What this changes

**The budget is reachable, and only if splitting is a rule from the first screen.** #141 (the
prerendered shell and route-level splitting) and #140 (the budget as a blocking check) currently
sit *after* #137 and before any screen, which is the right order — provided they are actually done
before the screens rather than after. A budget check that arrives once five screens exist arrives
with a violation already in it.

## What the stack table got wrong

**`@radix-ui/react-combobox` does not exist.** D-52 names five Radix primitives — dialog, menu,
combobox, tooltip, popover — and Radix publishes four of them. The command palette needs something
else: `cmdk` (built on Radix, and what the measurement above used) or a hand-built listbox on
`@radix-ui/react-popover`. This is a decision, not an oversight to paper over.

## Versions resolved

```
react 19.2.8 · react-dom 19.2.8 · vite 8.2.2 · tailwindcss 4.3.3
@radix-ui/react-dialog 1.1.23 · react-dropdown-menu 2.1.24
@radix-ui/react-tooltip 1.2.16 · react-popover 1.1.23
cmdk 1.1.1 · @tanstack/react-query 5.102.8 · zustand 5.0.15
marked 18.0.12 · shiki 4.4.3
```

Every Radix package declares `react ^19.0` in its peer range — checked, not assumed.

## The lint rule D-52 requires does exist

*"A raw value in a component is a lint error."* Two plugins support Tailwind 4 **and** ESLint 10:

- `eslint-plugin-tailwindcss@4.4.0` — peer `tailwindcss ^4.0.0`, `eslint ^9 || ^10`
- `eslint-plugin-better-tailwindcss@4.7.0` — peer `tailwindcss ^3.3 || ^4.1.17`, `eslint ^7…^10`

Which of them actually refuses an arbitrary value under this repository's configuration is **not**
established here. That is the spike #137 owes before either enters the stack (D-57).
