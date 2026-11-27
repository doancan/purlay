# D-110. The interface is flat and quiet: one tone for getting around, one for the conversation

*Amended by D-206: The workspace is drawn once, at the head of the sidebar; the dark theme is layered greys, not black.*

**Amended 2026-10-12 by D-118**: navigation is dark navy in both themes and the accent is blue.

D-100 gave the interface an identity, and the owner replaced it on 2026-10-12 with one of their own: a
written brief and a reference screen, applied to Purlay as a preview they approved. They chose its
visual language and its layout, both themes, and a rail that holds only what already exists. The brief
was written for a generic product called *Relay* and drew things Purlay refuses or has not reached;
those were not taken (below), and nothing here changes a contract, a route, a keyboard path or a
state `UX.md` §8 requires.

**Decided.**

1. **Inter for prose, JetBrains Mono for code**, served from this origin exactly as D-100 serves a
   face: the Latin and Latin Extended subsets (ğ ş İ are in the second) by `unicode-range`, the SIL
   Open Font License beside the files, `font-display: swap` over a system stack, and no request off
   the origin. Sans in 400/500/600, mono in 400/500. **Mono now marks what is machine text** — code,
   a time, a count, a key, a hash — and a channel's name moves to the sans: it is a place you go, not
   something you type into a shell. Amends D-100's typeface.
2. **Flat surfaces.** No canvas and no floating cards. Navigation — the rail and the sidebar — shares
   one tone, the conversation sits on the window's ground, and one hairline divides them. Regions are
   separated by tone, not by boxes. Elevation is kept for what actually sits *above* something: an
   overlay, a message's hover controls, the composer, and the cards inside a message (a code block, a
   GitHub card), which get a one-pixel border and a one-pixel shadow. Amends D-100's cards and UX §9.
3. **The rail returns, holding only existing destinations.** 56px, left of the sidebar: the workspace
   tile (the switcher menu that was in the sidebar header), then channels, the inbox (a dot while
   anything needs you — the mention badges' fact, D-106), open questions (a neutral count, since the
   badge is for what needs you) and search, and at the foot a settings menu —
   theme, language, shortcuts. Every entry is a route or a menu that exists today; the rail adds no
   destination. Its top 28px is left empty as a drag strip for the desktop shell (D-14). The sidebar
   narrows to 240px and keeps the workspace name, the jump field, channels, people and your own row.
   Reverses UX §2's switcher-instead-of-rail and D-97's note retiring `size-rail`.
4. **Colour.** Light is the brief's palette — neutral greys and one deep navy accent — and dark is
   derived from it in the same terms: zinc grounds, a light navy for accent *text*, and the filled
   accent kept dark navy under white. **Neither theme is designed first any more**; both are designed
   together and the OS preference still chooses (D-98 §1). Three of the brief's values fail WCAG AA
   and are used only where contrast is not owed: its tertiary grey on text (text takes the next grey
   down), its strong border on a control whose edge is its only affordance (that edge takes a grey that
   reaches 3:1), and its status greens and ambers as text (text takes the existing `*-text` shades).
   The pairs the generator checks are the arbiter; this sentence is not.
   **A fill cannot become a word.** The accent is dark navy in both themes, so a navy word on a dark page
   would be illegible; a colour token may say `"role": "fill"`, and the generator binds it to Tailwind's
   `--background-color-*` and `--border-color-*` namespaces only — `bg-accent` exists, `text-accent`
   does not, and `styles.test.ts` proves it. Its words are `accent-text`.
5. **Scale.** Type 12/16, 13/20, 14/22, 15/22, 16/24, and a message body of 14px at 1.6. Radius 4
   for a key, 6 for a control, 8 for a row and an avatar, 10 for a card, 12 for the composer and an
   overlay. Avatars are rounded squares — initials on a tint, as D-100 decided — at 36px in the feed,
   28px in a thread and for your own row, 20px in the sidebar's lists. The feed is at most 760px and **hangs from the left edge**,
   which settles the disagreement between UX §2 ("centred") and the token's note ("left-aligned").
   *Amended by D-119:* a channel's feed and composer are centred, since a conversation with two edges
   needs both of them on screen.
6. **Density is in what is shown, not in how tightly it is set.** A sidebar row is 32px and message
   groups are 16px apart; the product stays dense because it shows one column and no chrome, which is
   what UX §1.2 was for. Amends that principle's wording, not its intent.
7. **Motion.** Hover and focus ease in 120ms; the palette opens in 150ms, scaling from 0.98 with a
   fade. A message still never animates in. Every duration is 0ms under reduced motion, as D-97
   already enforces. Amends UX §9's "effectively none".
8. **The composer has three buttons**: bold, a code block and a mention. Each *inserts markdown* into
   the plain textarea and each has a key; none of them is a WYSIWYG control, which UX §5 still refuses.
   *Amended 2026-10-12 (#370):* a fourth, **Attach a file**, beside them. It inserts no markdown: it
   picks files to upload (D-109), as pasting and dropping one do. It is no formatting control, so the
   rule that the composer has no WYSIWYG stands.
   *Amended 2026-10-13 — the `@` list (`UX.md` §5).* The mention button and a typed `@` are now
   followed, at the first letter, by a list of people, after the Superdesign *new-message-picker*
   suggestions. Three choices in it were not obvious:
   - **Who is offered is who the server would tell** (`resolveMentions`, D-34). A public channel: the
     workspace, from `GET /api/workspaces/:workspaceId/members`, which the sidebar has already loaded.
     A direct message: its other person (`Channel.peer`). A private channel: **its members now**,
     from `GET /api/channels/:channelId/members` (D-123), and still in the workspace — read only for a
     private channel, and nobody is offered while it is being read. Never the writer, never a handle
     the broadcast refusal would catch (D-12). Someone who wrote there and has left is not offered: a
     mention of them would reach nobody.
   - **The text box stays a text box.** The WAI-ARIA combobox pattern puts `role="combobox"` and
     `aria-expanded` on the input, and HTML allows neither on a `textarea` — axe reports both
     (`aria-allowed-role`, `aria-allowed-attr`; run on the component before this was written). The
     `textarea` carries what a `textbox` may: `aria-autocomplete="list"`, `aria-haspopup="listbox"`,
     and while the list is open `aria-controls` and `aria-activedescendant` naming the current
     `option`; a polite status says how many match. Focus never leaves the box.
   - **While it is open the list owns ↑ ↓ Enter Tab and Esc.** Enter chooses and never sends; Esc
     closes that `@`'s list and nothing else. So that it does not take Enter for nothing, it opens
     only for a letter after the `@`, and closes once a handle is typed in full and matches nobody else.

   - **A handle typed out is first**, above every name that merely starts with it: `@ali` and Enter
     mention Ali, never Alice because her name sorts first. **The list opens only at the end of a
     name**: with the caret inside one already written, choosing would leave the rest of it behind.

   *Rejected:* who the client has seen in a private channel's loaded messages — first built that way,
   it offered people who had left (the server drops them) and missed quiet members; the member list
   of D-123 is exact. The whole workspace in a private channel — it
   offers names the server then drops without a word (`CONTRIBUTING.md` §6.4). `role="combobox"` on the
   `textarea` with the audit rule switched off for it — an exception to satisfy a pattern HTML forbids
   (D-48). Opening on a bare `@` — punctuation often enough that a list taking Enter would swallow a send.
9. **The day** is a label at the column's left with a rule after it, not a centred chip. Amends UX §3.

**Not taken from the brief, and why.**

- *A thread panel on the right.* PRD §4.2 is the product's wedge: threads open inline under their
  parent. The reference's panel is the one thing the product exists to refuse. *Reversed by D-122:*
  the owner chose the panel.
- *A call button, CI and deploy event rows, an incident banner, an Integrations section.* Audio and
  video are permanent non-goals (PRD §6); webhook feeds are Phase 2 (PRD §4, D-5). A diff block is the
  Phase 2 diff viewer.
- *Presence dots and photographs.* There is no presence to show yet (UX §2); photographs wait on the
  `avatar_url` proxy (D-100 §revisit).
- *The name.* The product is Purlay.
- *A light theme only.* D-98 §1 stands.

**Rejected.**

- *One change for the whole interface.* Every visual snapshot moves at once and a regression is
  invisible among sixty intended ones. It is delivered in four steps — tokens and type; the frame;
  the channel; the other screens — each green on its own.
- *Carrying it as a third theme until it is finished.* Two half-designed languages in the product,
  and D-97 makes a third theme a decision of its own.
- *Keeping the brief as a document.* Its values now live in `packages/tokens/tokens.json` and its
  layout in `UX.md`; a third copy that nothing checks is what `CONTRIBUTING.md` §6.1 forbids. It stays in
  the history, in the change that added it (#366).

**Cost of reversing:** the token file, the fonts and the shell's components. No contract, route,
schema or stored value depends on any of it.

**Revisit when** the desktop shell (D-14) is built: the drag strip's height is a guess until the
window draws its own controls.
