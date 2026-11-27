# D-120. Online presence is Phase 2 — closes #416

`PRD.md` §4.1 listed "typing indicators and presence" in Phase 1; `UX.md` §2 drew no presence dot
because "there is no presence to show (Phase 2)"; D-114 built typing and left the phase of presence to
the owner. Two documents disagreeing is a defect in one of them. Decided by the owner.

**Decided: online presence is Phase 2.** `PRD.md` §4.1 drops it and Phase 2 lists it; `UX.md` §2
already said so and now names this decision; nothing in the code changes, because nothing in it
shows presence. `PresenceRegistry` keeps only its typing half until presence is built (#480,
`ARCHITECTURE.md` §6.1).
1. **Quiet by default (D-12) and the resolvable thread are the product's reasons to exist;** a green
   dot is neither. (Written as "the inline thread"; it opens in a panel since D-122.)
2. **On one node, "online" means "has a tab open".** A team learns to ignore that within days, and the
   inbox and mentions already reach people who are away.
3. **Typing (D-114) answers the question presence is most often asked for** — is anyone here right now —
   in the channel where it is asked.

**Rejected:**
- *Pulling presence into Phase 1, before the first production launch.* About two pull requests (the
  online half of the registry with a reconnect grace, a `PRESENCE` frame per workspace, the dot), built
  on a guess about what the team will miss, ahead of the launch that measures it.
- *Dropping presence altogether.* That is a claim about use nobody has observed yet; dogfooding is
  where it is observed.

**What watches it:** #480 on the `v0.3.0` milestone. If the team's first weeks on the server (#224)
show nobody misses it, the change is a decision dropping it, not the build.

**Cost of reversing:** this decision, two lines of `PRD.md`, and #480 moved to the current milestone.
