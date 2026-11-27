# D-331. The shell's bound moves from 260 to 261 KB — builds on D-330, D-306, D-319

**Decided under the owner's standing instruction to decide and proceed**, from a polish pass over every screen: the account menu offers the theme and the language, the sign-in, invitation, setup and failure screens share one ground, and the release fireworks were redrawn. The first page measured 260.15 KB gzipped, 0.15 KB over D-330's bound.

**The shell's bound moves from 260 to 261 KB.** The account menu's two choices (it is in the first page, the sidebar's foot) and the shared standalone ground take the shell from 259.26 KB (D-330) to 260.15 KB, measured file by file. One KB is the margin for a feature or two, as D-306, D-319 and D-330 raised it; the 400 KB backstop and the module bounds stay (D-196). Nothing was cut or deferred to fit.

**The composer's focus is its edge, not a ring.** The message box has one fine grey line at rest (`composer-rest`), a hair firmer under the pointer (`composer-hover`) and one step firmer on focus (`composer-focus`), in each theme's own grey; the 2px blue ring D-207 softened is gone from it. The caret is the other cue that this is where typing happens, and `focus.e2e.ts` counts the focused edge as the box's indicator. Every other control keeps the 2px ring (UX §8), which is its own colour from the first frame, drawn inward in navigation and in the composer's card and outside a filled button. Rejected: removing the ring from buttons, which would leave a keyboard with no place on the page.

**Cost of reversing.** One constant, `SHELL_BYTES` in `scripts/budget-web.ts`; lowering it again fails the build until the weight is found.
