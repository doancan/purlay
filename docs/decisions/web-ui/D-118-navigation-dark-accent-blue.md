# D-118. Navigation is dark in both themes, the accent is blue, and the vocabulary check judges each class alone

**Amends D-110 §3 and §4.** The owner carried the brief further on Superdesign (project *Relay —
Developer Team Chat*, draft *Refined Modern Polish*, v10) and asked for the product to match it. That
draft is now the design the tokens are kept to; `tokens.json` remains the only copy in this repository
(D-97), and its `meta.source` names the draft.

**Decided.**

1. **Navigation has its own tone, dark in both themes.** The rail (`nav-rail`) and the sidebar
   (`nav-surface`) are deep navy whatever the theme, with their own hover, hairline and two inks
   (`nav-hover`, `nav-border`, `nav-ink`, `nav-ink-muted`). They are judged against their own grounds
   in `pairs.ts`, not against the conversation's. `surface-000` stays as the window's outer ground
   (sign-in, home). Amends D-110 §2's "navigation shares one tone with the window's greys".
2. **The accent is blue** (`#2563eb`, hovered `#1d4ed8`), a fill under white in both themes; its
   words are `accent-text`, blue in light and a light blue in dark. The current sidebar row is the
   filled accent. Navy is kept where the draft keeps it: the keyword colour in code. Amends D-110 §4's
   "one deep navy accent". `role: "fill"` stands: `text-accent` still does not exist.
3. **The focus ring is no longer `accent-text` in light**: it must be seen on white *and* on the navy
   navigation, and the blue of the text does not reach 3:1 on `nav-surface`. It takes the next blue up.
4. **The composer has its own elevation**, `shadow-raised`, between the one-pixel card and the overlay.
5. **Navigation is drawn in the dark theme** (`data-theme="dark"` on the rail and the sidebar), so every
   shared control inside it — a menu button, a key, a section's loading and failure — speaks the dark
   theme's inks on the navy without a second set of components. `pairs.ts` judges those inks on the
   navy grounds in the dark theme only, which is the only theme they are drawn in there.
6. **The channel, as the draft draws it:** a message is named by the person's display name, rows are
   16px apart with their avatar, the day is an uppercase label between two rules (amends D-110 §9), the
   unread marker is a rule and a word in the danger colour, a code block's header is plain mono, a
   reaction is a 4px chip, and the send button carries the key that sends.
7. **A focus ring on a card with its own edge is drawn inward**, over that edge: outside it, the 2px
   gap read as a second border.

**And the check that holds pages to this vocabulary did not work.** `checkVocabulary` gave one
Tailwind compiler every class in turn; Tailwind's `build` returns the CSS of every candidate it has
seen, so after the first accepted class nothing could "build to nothing" and a raw value was blamed on
the class after it. `bg-blue-500`, `p-7` and a typo passed; `CONTRIBUTING.md` §4 said they failed. Each
class is now judged by its own compiler (the whole application in well under a second), and a test
judges classes in a row, as the application is judged. Opening it found five classes that had built to
nothing since they were written — the retired `w-gutter`, `py-16`, and the send button's `size-control`
— now spoken in tokens. The extractor also stopped reading a compared value (`status === 'failed'`) or a
function's argument (`buttonStyle('primary')`) as a class.

**Not taken**, as in D-110 and for the same reasons: the thread panel (since taken, D-122), the call button, CI and deploy
rows, the Integrations section, presence dots and photographs, the GitHub card's Approve button,
the Starred section, collapsible sections, the typing line and the member stack in the header.

**Cost of reversing:** the token values and the shell's classes. No contract depends on them.
