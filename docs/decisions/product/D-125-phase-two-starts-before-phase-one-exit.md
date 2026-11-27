# D-125. Phase 2 starts before Phase 1's exit is demonstrated, by the owner's decision

D-4 binds a phase's work to its phase, and `CONTRIBUTING.md` §1.1 does not start the next one early.
On 2026-10-13 every Phase 1 issue that code can close was closed; what keeps `v0.2.0` open is the
deployment (#224, the server goes up the next day) and the measurements only use can give (#61,
#75). The owner decided to go on building **Phase 2** in that gap rather than wait on it.

**Decided.**

1. Work on `v0.3.0` begins now, in this order: **(1)** Web Push (#78), group conversations (#486),
   saved items (#484), pins and files (#485), profiles (#488), starred channels (#489); **(2)** the
   diff viewer (#80), GitHub feeds (#79), edit history (#82), presence (#480), incident channels
   (#487); **(3)** magic-link sign-in (#81), retention and erasure (#83), workspace export (#84).
2. **The screens' features join Phase 2.** #484–#489 came from the Superdesign screens and each asked
   which phase it belongs to: Phase 2, and `PRD.md` §4 lists them.
3. **Phase 1 is still the floor.** A defect found in a Phase 1 feature is fixed before Phase 2 work
   goes on, and `v0.2.0` closes when its exit is demonstrated (S-1), not when its issue list is empty.
4. Each feature still answers its own open questions as decisions of its own; this decision moves
   the schedule, not any rule of how the work is done.

**Rejected.** *Waiting for the deployment to start Phase 2* — a day, and then a week of dogfooding,
with nothing to build that the team asked for; the risk it guards against (Phase 2 work on top of a
Phase 1 the team has not used) is held by item 3. *Re-labelling the features Phase 1* — it would
make `v0.2.0` never finish, and S-1 is a measurement of the product as specified.

**Cost of reversing:** this paragraph and the PRD's Phase 2 line; nothing built depends on the order.
