# D-124. What is the person's and what is the workspace's — #495, #496, #497

*Amended by D-207: The account door reads as a menu, the menu opens with who you are, and "you are here" has one tone.*

**Amended 2026-10-19 by D-146**: Settings are a page; the account menu, the workspace menu and the
rail's foot are as D-146 §4 says.

Deep Work started only from `Cmd/Ctrl+Shift+D`, for a fixed hour, though the API takes any instant
within `DEEP_WORK_MAX_HOURS` (D-108). The sidebar's foot showed who was signed in and did nothing;
signing out was an item of the workspace menu, though it is not the workspace's; and *sign out
everywhere* (`POST /auth/logout-all`, the capability D-11 chose database-backed sessions for) had no
door at all. The design (`frontend-feed.html`) puts an account control at the sidebar's foot. Decided
in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Deep Work is started for a chosen while** — 30 minutes, an hour, two hours, or until tomorrow —
   and the instant is what `PUT …/deep-work` is sent, so it is the server's delivery that stops (D-15,
   D-108); the client paints it first and puts it back on a refusal, as before. *Until tomorrow* is nine
   the next morning in the person's own time — the coming morning when it is chosen before five, as
   the night is not over then — and never later than the server's bound less five minutes, so a clock
   here a little ahead of the server's cannot turn it into a refusal.
   `Cmd/Ctrl+Shift+D` still starts it for an hour; the command palette and the account menu offer
   every while, and while it is on, its end — the menu with until when and the minutes left.
2. **The browser tests that end a person's sessions, or change their Deep Work, act as outsiders.** The
   demo seed makes two people in no workspace, each signed in twice (`demo-seed.ts`); a test makes a
   workspace of its own for one of them. Done as one of the four seeded people, Deep Work would quiet
   the badges other tests photograph, and signing out everywhere would revoke the session every other
   test of the run signs in with.
3. **The sidebar's foot is the account menu.** The whole row — avatar, name, `@handle`, and a
   preferences glyph — is one button, and what it opens is everything that is the person's rather than
   the workspace's: Deep Work, the theme, the language, the shortcut reference, *Sign out* and *Sign out
   everywhere*.
4. **Theme, language and the shortcut reference move there; the rail's gear goes.** One home each
   (`CONTRIBUTING.md` §6.1): mirrored on the rail they would be two doors kept in step by nobody, and a
   gear left with nothing in it is a door to a door. The command palette keeps offering them, as it
   offers everything — it is the product's search over its actions, not a second menu. The gallery,
   which has no account, wraps the *same* items (`PreferenceItems`) in a menu of its own.
5. **Signing out everywhere asks first.** It ends sessions on devices that are not in front of the
   person, so it is a dialog with the choice named on its button, and a refusal is a toast with the
   person still signed in — as signing out here already was.
6. **A workspace is renamed, and its slug stays** (`PATCH /api/workspaces/:workspaceId`, an owner's
   or an admin's, `ARCHITECTURE.md` §7.4). The slug is the address in every link already pasted into
   a chat or a bookmark; moving it with the name would break them all for a cosmetic change. The same
   name again changes nothing and records nothing. The trail (D-26: *workspace settings change*)
   keeps the name before and after — a setting an admin typed, not anything a person said.
7. **Every member's tabs hear it as `WORKSPACE_UPDATED`, on each member's own `user:` topic, carrying
   no state**: the client reads its memberships again. The members are read as the rename commits, so
   somebody removed a moment before is not told. `DELETE` of a workspace stays unbuilt (①).
8. **The workspace menu opens from the workspace's name at the top of the sidebar**, with a chevron,
   as the design draws it; the rail's tile stays a second door to the same menu — one component, one
   list of items, as the jump field and `Cmd/Ctrl+K` are two doors to one palette. It gains **Create
   workspace…**, anybody's (the API lets anybody make one), which is the first-run form of `/` in a
   dialog: `/` sends a person with a workspace straight to it, so until now a second could not be made.
   *Amended by D-155:* not anybody's — the operator's `WORKSPACE_CREATORS` says whose, and the item
   is offered only to them.

**Rejected.**

- *Publishing on `workspace:`.* No socket listens on it, and one that did would have to be told when
  its person leaves; a removed member's tab would keep hearing the workspace until it reconnected.
- *The new name in the frame.* Two renames can be heard in the opposite order to their commits, and
  ordering them needs a version column on `workspaces` (`0015_state_versions`) for a row that changes
  a few times in its life. Reading the memberships again is one request and cannot be out of order.
- *The slug following the name.* See 6.
- *A submenu for the durations, or a picker for any time.* Each is a new primitive (D-52) for four
  choices; the server's bound already makes "any time" mean "any time today or tomorrow".
- *Keeping Sign out in the workspace menu as well.* Two homes for one act.
- *A Settings page.* Five choices fit in a menu; a page is a route, a layout and a back button for them.

**Cost of reversing:** the choices in `deep-work.tsx`, `account-menu.tsx`, the footer and the rail's
foot, the palette's Deep Work items, the seed's outsiders, and this decision; for the rename, the
endpoint, its audit action and `WORKSPACE_UPDATED` — a frame a client older than it ignores as unknown
(D-82), so removing it breaks nobody.
