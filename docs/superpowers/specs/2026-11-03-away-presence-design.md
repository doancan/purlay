# Away: idle after five minutes, and away by choice — design

Date: 2026-11-03. Decided by the owner in conversation; it amends D-136 §1 ("no idle guess, no
'away'"), so it lands with its own decision (the next free number, D-257 at the time of writing).

## Intent

Today a person is shown online — a green dot on their avatar — for as long as Purlay is open in any
tab (D-136). A laptop left open on a desk reads as somebody who is there. The owner wants what Slack
does: a person who has not touched Purlay for five minutes is shown **away**, and turns green again the
moment they use it. And a person can say they are away themselves, from the account menu, and stay so
until they say otherwise.

Success: a teammate glancing at People or a conversation's heading can tell "here now" from "has it
open but is not at it", and somebody stepping out can say so with one click.

## Goals

1. **Three states, as others see them:**
   - **Active** — online and used in the last five minutes: the green dot, as today.
   - **Away** — online, but idle for five minutes, or away by choice: a hollow grey ring in the dot's
     place. A screen reader reads "away" ("uzakta") where it reads "online" today.
   - **Offline** — Purlay not open anywhere: nothing, as today (D-136 §4: offline and unknown draw the
     same).
2. **Idle after five minutes.** Activity is the person's own input in a Purlay page — a key, a pointer
   moving or pressing, a touch, a scroll or the wheel. Five minutes (`AWAY_AFTER_MS = 300_000`) without
   any, in every page the person has open, makes them away. A page in the background, or hidden,
   receives no input, so it goes idle by itself; using another application does not count as activity.
3. **Back at once.** The first input in any page of theirs makes them active again, told straight away —
   not after the next minute's tick.
4. **Any page counts.** With Purlay open on a laptop and a phone, input on either keeps them active;
   they are away only when every page has been idle for five minutes.
5. **Away by choice.** The account menu has *Set yourself as away* ("Uzakta görün"); while it is on, it
   reads *Set yourself as active* ("Etkin görün"). Away by choice:
   - wins over activity: the person stays away while they use Purlay, until they turn it off;
   - is the person's, not a page's: it holds on every device and in every workspace, and survives a
     reload, a sign-out and a server restart (stored on the person, like the status line, D-131);
   - shows as the same hollow ring — others do not see whether the away was chosen or idle.
6. **Your own state is shown to you.** The avatar in the account menu carries your own dot or ring, so
   you can see that you are away (by choice or not) without asking anybody.
7. **The same reach as online.** Away is told to exactly the people online is told to today (those
   who share a workspace, D-136 §1), on the same frame and versioning, and on one node or several
   (D-201) alike.

## Non-goals

- No "last seen 12 minutes ago", no idle duration shown anywhere: away is a state, not a clock.
- No setting for the five minutes; one fixed value.
- No "away until 15:00", no scheduled away, no expiry on the status line (D-131 §5 stands); these are
  separate requests if they come.
- Deep Work (D-15, D-234) is untouched and separate from away; neither changes the other.
- Push (D-143) keeps its own rule: whether a push is held still reads the per-workspace `ACTIVE` word,
  not the away state. Away by choice does not hold or release pushes.

## Anti-goals (a failure even if it works)

- A person shown away while they are typing or reading in Purlay (any input must count, and the way
  back must not wait for a tick).
- A dot that flickers: a page that is active must not send a frame per keystroke or per mouse move
  (O-4's frame budget); a state is told when it changes, and only then.
- Away leaking further than online: a stranger, or somebody removed from the workspace, must never
  hear it.
- Away by choice silently undone by a reconnect, a second tab, a deploy or a node dying.

## Constraints

- D-136 §2's grace before offline, §3's versions that only grow, and §4's "draw nothing you cannot
  know" all hold for away as they do for online. A client keeps the largest version per person; an
  away heard after the active that followed it must not win.
- The contract lives in `@purlay/types` (`PresenceChange` gains the state; the snapshot from
  `GET /api/workspaces/:workspaceId/presence` carries it too). Old clients reading a new frame are not
  a concern: the web client ships with the server.
- On several nodes (D-201, `redis-presence.ts`), "every page idle" means every socket on every node;
  a node dying must not leave a person stuck active or stuck away beyond `PRESENCE_NODE_TTL_MS`.
- Away by choice is a column on `users` (migration), set through the person's own API (beside
  `PATCH /api/me/profile`, D-131 §2), audited nowhere (it is the person's own state, like the status
  line). A change is told on the `PRESENCE` frame, not `WORKSPACE_UPDATED`.
- The new client-to-server signal (a page going idle and coming back) is rate-limited like the other
  client frames (`frame-profiles.ts`), and refused for nothing it does not name.
- The visual: a hollow ring the same size as the dot, in the muted ink token, readable in light and
  dark, and the gallery baselines refreshed. Words in `en.ts` and `tr.ts`: "away" / "uzakta", "Set
  yourself as away" / "Uzakta görün", "Set yourself as active" / "Etkin görün".
- Docs in the same change: the new decision amending D-136 §1, `UX.md` where presence is drawn and the
  account menu, `API.md` and `SCHEMA.md` for the route and the column, the changelog, the README count.

## Decided in conversation

- Activity is input in Purlay's own page only (the owner's choice).
- Five minutes, fixed.
- Away by choice is wanted (the owner's choice); it lasts until turned off and wins over activity (my
  call, as Slack does; the owner was told).
- The hollow grey ring for away (my call, proposed to the owner without objection).

## Settled after the builder check (my calls)

1. **Silence is idleness; the server decides.** A page can be frozen by the browser (a background tab,
   a sleeping phone) with its socket still open, so a page's own "I am idle" cannot be relied on. A
   page in use speaks while it is used — on the person's input, no more often than once a minute — and
   at once on the first input after a quiet spell. The server holds the last word per person and
   counts the person away when no page of theirs has spoken for `AWAY_AFTER_MS`. On several nodes the
   last word lives where the online claims live (`redis-presence.ts`), and a sweep tells the lapse, so
   a frozen page or a dead node cannot leave anybody stuck active.
2. **A socket that opens starts active**: opening or reloading Purlay is the person's own act. A
   reconnect the page makes by itself (a network blip) carries the time of the page's last input, so a
   person idle for an hour is not turned green by their Wi-Fi.
3. **Away by choice is ordered with the rest.** The route writes the column first, then tells the
   change through the same announcement path as online and offline, at a new version from the same
   source, retried as presence is (D-136); a client that missed it reads the snapshot again on
   reconnect, as today. A socket that opens reads the column before its first word, so the first
   state anybody hears for that person is already away.
4. **Offline wins.** Turning away on or off while offline is stored and tells nobody. The snapshot stays
   "the members online", each now with their state; nobody offline is listed.
5. **Your own ring is what the others see**: read from your own entry in the snapshot and the frames,
   not worked out by the page, so a laptop and a phone show you the same state. If the snapshot leaves
   the reader out today, it includes them from now on.
6. **The menu knows the choice from the start**: `GET /api/me` carries it beside the profile fields
   (D-131 §3), so the label is right on the first draw.

## Left to the builder

- Whether the page's words are a new client frame or the existing `ACTIVE` frame (D-143) extended. It
  is per workspace, at most one a minute, and kept per node for two minutes for the push rule — which
  must not change either way.
- The exact shape of the state on `PresenceChange` (a boolean `away`, or a `state` enum).
- The route's name and verb for away by choice.
