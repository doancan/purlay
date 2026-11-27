# D-52. The frontend architecture: constraint, evidence and friction

`UX.md` specifies behaviour beautifully and says nothing about how the code is shaped. Interface
quality of the kind named as the bar is not produced by taste applied repeatedly; it is produced by
**having few choices, checking the result, and making novelty cost something**.

**1 · Constraint — one source for every visual value.**

Design tokens (colour, spacing, type scale, radius, shadow, motion duration and easing) are
declared once and consumed through Tailwind's theme. **A raw value in a component is a lint
error** — `CONTRIBUTING.md` §4 already forbids arbitrary Tailwind values, and this extends that
rule to the whole vocabulary. What makes an interface look designed rather than assembled is not
inspiration; it is the absence of a way to be inconsistent.

**2 · Primitives — headless, for the five things that are genuinely hard.**

Dialog, menu, combobox (the command palette), tooltip and popover. Focus management, focus
trapping, ARIA wiring and keyboard semantics are where hand-written components fail **silently**:
they look correct and are unusable with a screen reader, while `PRD.md` §5 states accessibility as
a requirement.

**Radix**, verified rather than assumed: actively published, one package per primitive so only what
is used ships, which matters against D-49's budget. **Amended 2026-09-09 — it is four primitives,
not five.** Radix publishes no combobox; `@radix-ui/react-combobox` does not exist, which was found
by installing them rather than by re-reading this paragraph. Dialog, menu, tooltip and popover are
real and were built against; the command palette is **O-7**. *`@base-ui-components/react` was the obvious
modern alternative and is **deprecated at release-candidate stage** — checked, not remembered.*
Everything outside those five primitives is written here: a button that pulls in a dependency is a
dependency that owns your button.

**3 · Evidence — the interface is checked, not admired.**

- `axe` on every component and every screen, in CI. A stated accessibility requirement with no
  check is not a requirement.
- A **keyboard-path test per screen**: every action reachable by mouse is reached by key, because
  `UX.md` §7 says the product is keyboard-first and that claim needs an owner.
- **Visual regression snapshots.** The only mechanical way to notice an interface breaking
  quietly. Its maintenance cost is real and accepted; the alternative is finding out from a user.

**4 · Friction — a new primitive must justify itself in the pull request.**

Exactly what `CONTRIBUTING.md` §1.12 does for runtime dependencies, applied to components.
Interfaces do not decay by a bad decision; they decay by fifty reasonable ones, each adding a
variant nobody consolidated.

**Testing shape:** `bun test` with `happy-dom` and Testing Library for component logic and
accessibility; Playwright for keyboard paths, visual snapshots and the cold-load measurement
D-49 needs. Two tools with two jobs, not two tools doing one job.

**Amended 2026-11-26 (#1568): `prosemirror-view` is held at 1.43.0.** From 1.43.1 on (1.44.0 is the latest),
the cursor moves across node boundaries by a different rule, and under `bun test --coverage` with
`happy-dom` the editor adapter's block-command test recurses until the stack is gone (`Selection.collapse`
dispatches an event, ProseMirror sets the selection again, and so on) and times out. Real browsers are not
affected; the Playwright suite passed on 1.44.0. That is the limit of the `happy-dom` half of this decision
showing: it emulates a selection, it is not one. The pin moves when a later release passes
`rich-editor.test.tsx` under coverage, either because `happy-dom` stops recursing or the test no longer
triggers it. The test was not changed.

**Rejected — a component library with opinions** (a full design system package). It brings a visual
identity that is not ours and a bundle we do not control, and the interface is the product's face.

**Rejected — no primitives at all.** Hand-writing a combobox with correct ARIA and focus behaviour
is a fortnight, and it will still be wrong in a way nobody notices until somebody using a screen
reader tries the command palette.
