# D-362. Premium polish: layered shadows, Inter features, calmer composer, front door — amends D-110

**Decided (the owner, 2026-11-28).** The interface read as too plain for an enterprise product. The owner asked for a
more premium, clearer feel with the main colours untouched. No colour token changed; what changed is depth, type, density
and the front door.

**What changed.**

- **Layered shadows.** `shadow-card`, `shadow-raised` and `shadow-float` are each a contact line plus one or two soft
  ambient layers; the token grammar accepts layers joined by ", " (and `inset`). Regions are still separated by tone, not
  by shadow (D-110 §2): the layers only soften what already stood above something.
- **Lighter, bluer light pages.** The light theme's page grounds, hover tracks, code ground and hairlines move toward the
  navigation's cool blue and a step lighter (`surface-000` #f5f7fc, `surface-050` #f9fafd, `surface-200` #eef1f8,
  `border-subtle` #dfe3ee, `border-default` #cdd3e3, the composer's three edges alike); text, accent and the dark themes
  are unchanged, and the generator's contrast audit still passes.
- **Inter, set with more care.** `cv11`, `ss03`, `calt` and kerning on the page, grayscale smoothing, and a little
  negative tracking on `title` (-0.011em) and `heading` (-0.008em). Times are Inter with tabular figures, no longer
  JetBrains Mono: mono keeps code, a hash, a key and a count. Amends D-110 §1, which put a time in mono.
- **A calmer composer.** The key hints (Enter, Shift+Enter, ```) are no longer printed beside the buttons; the keys work
  all the same and stay in the field's description for assistive technology at every width. The formatting row is always
  drawn, with its glyphs at the control size (16px), and a press on a tool keeps the focus in the box.
- **Sidebar and messages.** Section headings are caption-sized and semibold; a message row takes `surface-050` under the
  pointer; an avatar carries `shadow-card`.
- **The front door.** Screens outside the app stand on a cool gradient between `nav-surface` and `nav-rail`, and the card
  is `shadow-float` with more room. Sign-in leads with the address and password, then an "or" and the single sign-on
  buttons; "Sign in with your company" is closed until asked for (open when a workspace is in the address).

**Rejected.** Hiding the formatting row until the box is focused: the owner wanted it always in view. Hiding it behind a
button: one more control to find. Backdrop blur on the header: not drawn yet,
since scrolling content under it needs measuring on a low-power device first. A new colour or a second accent: the brief
was to keep the main colours.

**Cost of reversing.** Low. The values are in `packages/tokens/tokens.json` and `index.css`; the composer's `hidden`
wrapper, the sign-in order and `DoorCard` are three small, separate edits.
