# D-98. The client is built end to end: no screen without its backend, and the owner pulls the wedge forward

The tokens (D-97) and the approved prototype exist; the client does not. This records the analysis
that decides the order and the edges before any screen is written, because the expensive mistakes in
a client are architectural and cheap to make in the first week.

**What the analysis found.**

1. *The backend serves less than the prototype shows.* Phase 0 has sign-in, workspaces, channels,
   messages (keyset) and the socket. Threads, resolution, the open-questions view, read state,
   reactions and DMs are Phase 1 (`API.md`) with no contract in `@purlay/types` — but the schema
   already has the columns (`parent_id`, `resolved_at`, `resolved_by`, the thread counters,
   `last_read_message_id`, the unread counters, `reactions`, `mentions`).
2. *The transport is done and the rest is not.* `apps/web/src/realtime` holds the connection,
   reconnect, cursors and clock, tested. There is no router, data layer, store, i18n, theme switch,
   accessibility harness or browser test.
3. *The budget decides the tools.* 250 KB gzipped initial, with the empty shell already about 60 KB
   (`PRD.md` §5). Every dependency below is justified against that number, and the build fails when
   it is exceeded (#140).

**Decided by the owner (2026-10-10): every control on a screen works against a real backend, end to
end.** D-53 already said no screen ships with a state unhandled; this adds that no screen ships with an
action unbacked — a button wired to a fixture is the prototype feeling D-53 exists to prevent, and a
fixture backend is a second implementation of an API that would have to be rewritten against the real
one. **`PRD.md` §4 and D-4 bind the phases, so this is the exception stated, not assumed:** the owner
pulls forward the slices of Phase 1 the approved prototype *is* — the wedge and what it needs to be
usable — and nothing else:

| Slice | Backend | Client |
|---|---|---|
| Phase 0 as specified | exists | sign-in, workspace and channel list, create channel, message list, composer, optimistic send, scroll anchoring |
| Threads and resolution | replies (`parentId`, I-1), thread counters, `GET …/thread`, `POST`/`DELETE …/resolve`, `GET …/unresolved` | the thread (inline; in a panel since D-122), Resolve/Reopen, the open-questions view |
| Read state and mentions | `@username` parsing (D-12, D-29), unread counters, `PUT …/read` (I-3, I-6) | bold channels, mention badge, the *New* marker |
| Reactions | `PUT`/`DELETE …/reactions/:emoji` | React, counts |
| DMs | `POST …/dms` (I-5) | People section |
| Navigation | none — the palette reads what the client already holds | `Cmd+K` palette, shortcut reference |

**Not pulled forward, and not built:** editing and deletion (O-1), attachments, search, the
notification inbox, Deep Work, invitations and roles, presence and typing (ephemeral, D-7), GitHub
cards and every Phase 2 item. The prototype's deploy, CI and diff cards were illustrations of what a
developer's channel contains; they need the GitHub integration, are Phase 2, and are not in the
client. An empty slot in the interface for any of them would be a control that does nothing.

**Every slice ships in one order:** the shape in `@purlay/types` first (`CONTRIBUTING.md`), then the
module and its integration tests, then the HTTP door and the socket frame (two doors into one
service, `API.md` §5), then `API.md`, then the client against it, then the browser test against both.

**What this decision adds to the client.** It builds on D-18, D-41, D-50 and D-52: React + Vite SPA
with a prerendered shell, TanStack Query for server state, Zustand for the realtime buffer, Radix
for dialog, menu, tooltip and popover, typed catalogues over `Intl`. Covers #138, #23–#27, #101,
#109, #139, #140 and #141.

**1 · Two themes, now.** `UX.md` §9 said light arrives in Phase 2, and D-53 said snapshots are taken
"in every theme that exists". Both are amended: dark and light ship together, because the tokens were
written with both (contrast is computed in each) and a theme added after the screens is a theme
retrofitted onto them. The theme is the OS preference until the person chooses; the choice is per
device (`localStorage`), applied before first paint by a same-origin script so there is no flash and
no inline script for the content security policy (#112) to refuse. A development-only **gallery**
renders every component and state in both themes side by side; it is also what the visual snapshots
photograph, so a theme can not be added to the product and missed by the tests.

**2 · A router of our own, about a hundred lines.** The client has a handful of routes. A router
library costs 15–25 KB of the budget to match a path and call `history.pushState`; the alternative is
a typed route table, a `Link` and a hook. Rejected: `react-router` and `@tanstack/react-router`
(size, and loaders and search-param machinery for routes this small); `wouter` (small, but untyped
paths). Reversible: call sites use `Link` and `useRoute`, so replacing the module changes one
directory.

**3 · The ports are interfaces, the adapters are the browser's.** The data layer takes `fetch`, the
socket opener, the clock, the id generator and `localStorage` as arguments (D-46 does the same for
the realtime code). A test drives a failed send, a dropped connection or a slow page by hand; a
Playwright test drives the same code in a real browser against the real API.

**4 · The message body is text, with exactly three exceptions.** The markdown pipeline is Phase 1
and its renderer and the server's sanitiser are chosen together (O-6), so this decision does not
choose a markdown package. The renderer recognises fenced code, inline code and bare `http(s)` links,
emits React nodes (never `dangerouslySetInnerHTML`, so there is no HTML to sanitise), and shows
everything else literally with its line breaks. It is one function, `renderContent`, which O-6's
renderer replaces without touching a caller. *(Amended 2026-10-11: O-6 is closed by D-101 — one
engine on both sides, so there is no separate server sanitiser to choose. #43 replaced the renderer:
`renderContent` now draws D-101's narrowed tree, and the three exceptions are gone.)* Fenced code is highlighted by Shiki with grammars
loaded on first use (D-36), coloured by the `--syntax-*` tokens, so the initial chunk holds none.

**5 · Read position is the server's.** The unread marker is placed at `last_read_message_id`,
written by `PUT /api/channels/:id/read` when the bottom is reached or the channel is left, never on
mere render (`UX.md` §6). It follows the person across devices, which a client-side value would not.

**6 · Performance is a feature with numbers.** Typing paints the person's own message in the same
frame (state, not network); history is rendered as a bounded window of 50 (`UX.md` §6, O-5) with
`content-visibility: auto` on rows outside the viewport; code, the highlighter, the dialogs and the
gallery are separate chunks; a row is memoised on `(id, editedAt, delivery state)`. The browser test
measures keystroke-to-paint and channel switch against the budgets, and `bun run budget:web` fails
the build, naming what grew, when the initial chunk passes 250 KB gzipped.

**7 · What the palette is built on (closes O-7 for this decision).** Radix publishes no combobox. The
palette is a Radix `Dialog` holding a hand-written listbox that follows the WAI-ARIA combobox
pattern, with `axe` and a keyboard-path test in CI — the argument for primitives (focus and ARIA fail
silently when hand-written) is met by testing exactly that, and `cmdk` is not adopted: it is a
dependency on top of Radix for the part of the pattern that is thirty lines.

**Rejected — wiring the prototype's thread screens to a fixture backend.** It would demo well and
cost more than it shows: a second implementation of an API, a contract guessed in the client, and a
rewrite when the real one differs. The owner's instruction is the opposite, and this records why it is
right.

**Rejected — one large pull request.** The work lands as one commit series per slice so it can be
reviewed and, if needed, split along the issues; `large-change` applies where a single slice exceeds
the budget.

**Reversibility:** the router, the content renderer and the highlighter each sit behind a single
module on purpose. The theme mechanism and the ports are expensive to retrofit and cheap to write
first, which is why they are first. Pulling a Phase 1 slice forward is not reversible once data
exists, which is why each ships with its integration tests and its documentation in the same change.
