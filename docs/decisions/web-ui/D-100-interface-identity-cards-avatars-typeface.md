# D-100. The interface has an identity: floating cards, avatars, and one typeface served from here

**Amended 2026-10-12 by D-110**, which replaced the typeface and the cards with a flat interface set in
Inter and JetBrains Mono. **Amended again 2026-10-12 by D-119**, which puts messages in bubbles with your
own on the right: the avatars stand; the absence of bubbles and the single edge do not.

The first client (D-98) was built to the approved prototype and passed every test, and the owner
looked at it and said it looked like a prototype. They were right, and the reason is worth keeping:
the tests judged that classes compiled and that values were tokens, and no test judged whether the
screen was *designed*. Three things made it read as unfinished, and each had been decided on
purpose, which is why they are decided again here and not patched.

1. **The system font.** `fonts` in `tokens.json` was empty by rule (D-39: no third party is asked
   for a file; D-97's schema made adding a face a decision). A product set in whatever the machine
   has looks like every other product on that machine.
2. **No avatars, a log with one edge.** UX §3 argued that a channel scans like a log. It does, and
   it also reads as a terminal printout: nothing names who is speaking before the words do, so every
   row has the same weight.
3. **No surface hierarchy.** Sidebar, feed and composer were one flat panel divided by hairlines,
   and "no shadow" was a rule (UX §9) that left nothing to show where one thing ends.

**Decided.**

- **A typeface, served from this origin.** IBM Plex Sans for prose, IBM Plex Mono for code, the
  time and channel names. Chosen because its mono is drawn as a sibling of its sans rather than as
  an afterthought, so the two sit on one line (`ECONNRESET` in a sentence) without a seam; it is
  licensed under the SIL Open Font License, which the repository ships beside the files
  (`public/fonts/OFL.txt`). The files are copied into `apps/web/public/fonts`, not fetched from a
  font service: D-39 stands, the CSP needs no new source, and no request leaves the origin.
  Two subsets (Latin; Latin Extended, which holds ğ ş İ — the owner writes Turkish) in the weights
  the type scale uses, so a page downloads only what its characters need (`unicode-range`).
  `font-display: swap` over a system stack: text is never invisible. `tokens.json`'s `fonts` array
  is now a list of `{ family, weight, file, range }` whose `file` must be a path under `fonts/`
  (a URL is refused by the schema, and a test fails if that changes).
- **Cards on a canvas.** A tinted `canvas` colour is the window's ground; the sidebar and the
  channel are `surface-100` cards with a `radius-lg` corner and one `shadow-card`. `radius-md`
  grows from 6px to 8px with it. Amends UX §9's "no depth": the *cards* float; a message, a code
  block and a control still have none.
- **Avatars, and still no bubbles.** An avatar (initials on one of six tints chosen from the
  username, so it is stable and needs no image fetch and no stored colour) sits in a fixed column.
  The text is not put in a bubble: a bubble turns a code block into a box inside a box and narrows
  every line, which is the wrong trade for a tool whose messages are half code. Own messages stay
  on the same edge. The gutter token is retired. This amends D-98 §no-avatars and UX §3.
- **A new UI primitive, `Avatar`, justified under D-52:** it replaces nothing and exists in six
  places (feed row, thread reply, sidebar person, the person's own footer, the DM header, the palette); six hand-written
  copies would be the "fifty reasonable additions" D-52 warns about. It has one job — initials on a tint —
  and no behaviour. There is no presence dot: there is no presence, and a dot that is always one
  colour would be a lie (`UX.md` §2).
- **The layout is mine to change, not the product's.** Where the sidebar sits, the header's
  segmented control for Feed / Open questions, the composer as a card with a send button on its
  right edge: all of that is presentation. Nothing here changes a contract, a route, a keyboard
  path or a state UX §8 specifies.

**Rejected.**

- *Bubbles, own messages on the right* (the reference the owner showed). Right: the genre's
  convention and what most people have seen. Wrong here for the code-block reason above, and
  because a developer channel is read by following a thread, not a speaker.
- *A variable font.* One file instead of six, but the Latin Extended subset of a variable Plex is
  larger than two static weights, and the type scale uses four weights at most.
- *Google Fonts or `fontsource` at runtime.* A third party in the critical path, against D-39.
- *Photographs from GitHub's `avatar_url`.* The column exists (`SCHEMA.md` §2) and is the right
  Phase 1 upgrade; today it would add an image request per person, an off-origin host the CSP must
  allow, and a layout shift. Initials cost nothing and cannot fail.

**Revisit when** a workspace asks for its members' photographs, which is the trigger for the
`avatar_url` proxy D-39 §4 already specifies.
