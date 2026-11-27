# D-344. A shortcut is printed once, through `Kbd`, as this keyboard prints it: the Mac's glyphs, everyone else's words

**Decided (the owner, 2026-11-26).** The owner asked for the composer's hints to show the Mac's own signs (⌘ ⇧) rather
than words. Shortcuts were spelled at each call site (`keyLabels`, string building), so the same key read differently
in a menu, a tooltip and the composer, and off a Mac some ran together ("CtrlK" in the jump field, "Ctrl/" in menus).

**What changed.** A shortcut is written in neutral words (`Mod+K`, `Shift+Enter`, `Esc`) and reaches the screen only
through `ui/Kbd`, which spells it with `ui/keys.ts`:

- On a Mac: ⌘ ⌃ ⇧ ⌥ ↵ ⌫ ⌦ ⇥ esc and arrows, the modifiers in Apple's order (⌃ ⌥ ⇧ ⌘) whatever order a feature wrote them,
  so `Mod+Shift+D` reads ⇧ ⌘ D as the menu bar prints it. Elsewhere: Ctrl, Shift, Alt, Enter, Backspace, Delete, Tab,
  Esc, in the order written, with a visually hidden `+` between caps so a screen reader says the chord.
- Each key is its own cap, `size-kbd` (20px) tall; a single glyph or letter is a square cap, a word is padded; caps are
  4px apart. One look in every tone: `surface-050` with a `border-subtle` hairline; only the ink follows navigation.
  Caps are hidden on touch-only devices.
- Platform detection is the existing one (`isMacPlatform`, now in `ui/keys.ts`, re-exported by
  `features/shortcuts/platform.ts`); a shortcut already spelled in Mac glyphs is printed as a Mac's.

The behaviour of a shortcut never depends on this: the listener accepts either modifier, only the printed words differ.

**Rejected.** Translating cap words (Ctrl, Shift) into Turkish: keyboards print them in English, and so does every
platform's own UI.

**Cost of reversing.** Low: `ui/keys.ts` and `ui/Kbd` are the one place; printing the written words instead of the
platform's is a change there and in their tests.
