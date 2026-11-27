# D-143. A push is held while its person is in front of that workspace's page — #545

**Context.** Web Push (D-126) told a person's devices what needs them even while they had Purlay open
and in front of them, so the phone in their pocket buzzed for what they were looking at. D-126 §5
makes the worker always show a push, so the place to hold one back is the server, before it sends.
Presence (D-136) is no help: online is having Purlay open in any tab, and a tab left open on a desk
while its person is away must not swallow the mention their phone should have told them of.

**Decision.**
1. **Active is a page that is visible and focused, used recently, in that workspace.** While its
   document is visible and focused, a page says so with an `ACTIVE` frame naming its workspace, on the
   person's own input — a key, a pointer, a touch — no more often than `ACTIVE_EVERY_MS` (60 s), and
   once as it comes to the front. The server holds the last word per person and workspace
   (`platform/attention.ts`) for two of those intervals, so one word lost on a slow socket does not end
   it. It is a guess, and it stays the server's: nothing shows it to anybody (D-136 rejected "away" as a
   fact about a person; this is only whether to buzz a pocket).
2. **Held for every device of the person, for that workspace only.** The page in front of them already
   says it — the inbox, the badges, the title. Active in one workspace holds nothing of another's.
3. **Held means dropped, never sent later** (D-12): a person who comes back to their phone after an
   hour at their desk is not handed a burst of what they already read.
4. **Authorised before it is held**: an `ACTIVE` for a workspace the sender is not in is the
   stranger's `404` and takes no place in memory. The frame is answered with nothing.
5. **In memory, per node** (D-7, D-25): a restart forgets it, costing at most a push that was not
   needed; on a second node a word heard by the other is not known here, and the push goes — the
   quiet side of wrong. Memory is bounded by the people active now: a word past its window is let go.

**Rejected.** *Presence* (an open socket) — a background tab on a desk would silence the phone in the
person's pocket. *Holding only other devices than the active one* — the active one is a page, which
does not get pushes while it is in front. *Deferring held pushes* — a burst later, against D-12. *A
frame on every input* — a frame budget spent on keystrokes (O-4); one a minute is enough for a
two-minute window.

**Cost of reversing:** the frame, `platform/attention.ts` and one filter in the push sender; no
migration.

*Amended 2026-11-03 by D-257:* §1's input list also counts a moving pointer and the wheel, and presence reads the
same word; the push rule is unchanged.
