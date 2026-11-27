# D-257. Away: idle for five minutes, or away by choice — builds on D-136, D-143, D-201; amends D-136 §1

**Context.** D-136 §1 refused "away": a guess at attention reads as a fact about a person. A laptop left open on a
desk then reads as somebody who is there. The owner asked for it anyway, as Slack has it: somebody who has not used
Purlay for five minutes shows as away, and a person can say they are away themselves.

**Decision.** `PresenceChange` carries `away`, and the snapshot each person's `away`. **Away is a guess about
attention, shown as a state — never a duration, never "last seen"** — drawn as a hollow ring in the muted ink where the
green dot is, and said "away" to a screen reader. Others do not see whether it was idle or chosen.
1. **The heartbeat is D-143's `ACTIVE` word**: one a minute while a page is visible, focused and used, and at once on
   the first input after a quiet spell. Its input list grows to a moving pointer and the wheel; the push rule
   (`attention.heard`) is unchanged, and the frame is not a new one.
2. **Silence is idleness, decided by the server** (`AWAY_AFTER_MS`, 300 s): a page the browser froze cannot keep
   anybody green. One node keeps the last word in memory; several keep it in the per-person Redis record (D-201) with
   an idle index swept on renewal, so an idle lapse may be told up to one renewal late. Any page of the person's
   keeps them active.
3. **A socket back inside the grace changes nothing** (D-136 §2): a Wi-Fi blip does not turn an idle person green. An
   arrival after being offline starts active: opening Purlay is an act.
4. **Away by choice** (`PUT /api/me/away`, `users.away_chosen`) is stored on the person, wins over activity, holds on
   every device and workspace and through restarts, and is read by a socket before its first word. The route writes,
   then tells it again at a new version from the same source as the others, to co-members only (D-136 §1, §3)
   and to the person themselves.
   Offline always wins: a choice made offline is stored and tells nobody. `GET /api/me` carries `awayChosen`, and the
   account menu offers *Set yourself as away* / *Uzakta görün*, and the reverse.
5. **Your own state is told to you**: every presence change also goes to the person's own `user:` topic, so the avatar
   on every page of theirs — account menu, People — shows what everybody else is told, chosen on another device or
   idle, which only the server knows. It is their own state, so nobody new hears anything. Disconnected, a page draws
   nothing for them rather than the last state it heard. While they are online, what they hear of themselves also
   carries `chosen`, whether the away is their choice, so the menu on every device of theirs offers the right one of
   *Set yourself as away* and *Set yourself as active* without a reload; newest version wins, as for the state. Nobody
   else is ever told `chosen`.
6. **Accepted edge**: with Redis unreachable for more than five minutes, a person who is speaking can be shown away for
   up to a minute after it comes back, until their next word.
7. Unchanged: D-136 §2 to §4 and §7, Deep Work (it does not change away, nor away it), and the push rule (D-143).

**Rejected.** *An idle threshold set per person* — one value is enough for a state, and a setting is a request that
can come. *"Last seen"* — a clock about a person, the thing D-136 refused. *The page deciding its own idleness* —
a frozen background tab would stay green. *A separate heartbeat frame* — a frame budget spent (O-4) on what the
`ACTIVE` word already says.

**Cost of reversing.** The `away` field, the route and the column (a migration to drop it); `ACTIVE` goes back to its
input list.
