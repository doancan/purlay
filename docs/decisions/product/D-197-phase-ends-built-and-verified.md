# D-197. A phase ends on what is built and verified, not on the owner's team switching — supersedes S-1, amends D-1, D-4, D-73

**Context.** S-1 made Phase 1 wait for the owner's team to stay off another product for thirty consecutive days, and
made the cloud wait behind it. That is a statement about one team's habits, not about the product: it cannot be
reproduced, it cannot be checked in CI, and it left finished work (rate-limit numbers, list virtualization, the
internal deployment) "open" for want of a calendar. Quality is what a reviewer or a stranger can verify.

**Decision.**
1. **S-1 is replaced by a check that can be run.** Phase 1 is done when every capability `PRD.md` §4 lists works end to
   end in a browser at both widths and both themes, `bun run verify` passes, and the deployed build runs the newest
   commit. The measurements that were left waiting for a team's usage are taken with a synthetic load and decided
   from it (O-4, O-5).
2. **The cloud's gate is S-3's preparation, not S-1.** Cloud work still does not start before the self-host path (S-2)
   is real, and the cloud sells operation, not features (D-1); only the thirty-day wait is gone.
3. **Dogfooding stays a practice, not a gate.** The team's own server (D-73) is the deployment every change reaches;
   what it shows is read as a measurement, never waited for.

**Rejected.**
- *Keeping S-1 as a stretch goal.* A criterion nobody is held to is a sentence that makes readers doubt the others.
- *Dropping the gates altogether.* A phase with no demonstrated exit is a phase that never finishes (D-4); the exit is
  moved to what can be demonstrated, not removed.

**Accepted.** Product fit with the owner's own team is no longer proven by the process; it is judged by use, as for any
product.

**Reverses if** the owner's team, or a customer, reports that a verified product is not one they can work in, which
the check above would then be missing.
