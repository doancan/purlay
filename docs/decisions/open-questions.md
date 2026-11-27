# Open questions

Questions recorded so they are not silently assumed: each is closed by the decision it names, and a new one is
added here, not in a decision file. `bun run check:docs` refuses a decision filed among them.

Recorded so they are not silently assumed. None block Phase 0.

- ~~**O-1 · Message editing.**~~ **Closed by D-103:** no window, shown as edited; no history until
  Phase 2 — kept since D-135; a resolved thread is edited by the same rules.
- ~~**O-2 · Invitations.**~~ **Closed by D-115:** shareable links, made and revoked by an owner or
  an admin, opening for seven days to anyone signed in who holds one, as a member.
- ~~**O-3 · Retention & export format.**~~ **Closed by D-27:** retention is an opt-in
  per-workspace window that defaults to infinite, erasure is two deliberately separate
  operations, and export is NDJSON plus the attachment blobs. Implementation is Phase 2; the
  decision is no longer open.
- ~~**O-4 · Rate limiting — the number.**~~ **Closed by D-198:** ten frames a second with a burst of sixty,
  decided from a synthetic measurement of what a page sends (`bun run measure:frames`) instead of a week of dogfooding;
  the closing line of each socket and `bun run report:frames` stay as the check in use.
- ~~**O-7 · What the command palette is built on.**~~ **Closed by D-98 §7:** a Radix `Dialog`
  holding a hand-written listbox that follows the WAI-ARIA combobox pattern, held by `axe` and a
  keyboard-path test; `cmdk` is not adopted.
- ~~**O-6 · The two markdown packages D-36 named as categories.**~~ **Closed by D-101:** one
  engine, `mdast-util-from-markdown` with four GFM extensions, on both sides, narrowed to what the
  product renders and bounded so a body past the bounds is shown as typed.
- ~~**O-5 · Scroll virtualization.**~~ **Closed by D-199:** not adopted — measured on a 2,000-message channel of heavy
  rows, the window of fifty switches in 52 ms; what broke the budget was the older pages a channel kept after it was
  left (2.1 s to come back), so a channel out of view now keeps its newest page only. `purlay:channel-switch` stays
  in the page (`apps/web/src/app/switch-timing.ts`) for anyone who wants their own numbers.
