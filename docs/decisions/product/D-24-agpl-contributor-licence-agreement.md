# D-24. AGPL-3.0, with a contributor licence agreement

Amended 2026-09-09. The original decision chose MIT, and its reasoning was explicit:
*"D-1 explicitly gave up commercial ambition, so AGPL would guard revenue we have decided not to
pursue."* D-1 no longer says that. The premise changed, so the conclusion is re-derived rather
than defended.

**Decided: AGPL-3.0 for the whole repository, plus a CLA on every outside contribution.**

**Why AGPL rather than MIT, now.** With a cloud offering, MIT permits anyone to take this code and
run it as a competing paid service with no obligation of any kind. That was an acceptable trade
when there was no revenue to defend. It is not one now.

**Correcting an error in the original reasoning.** The old D-24 rejected AGPL because *"a
meaningful number of companies ban AGPL dependencies outright."* That is true of **libraries
linked into a company's own product** — and Purlay is not a library. A company running Purlay
internally is not conveying it to anyone and incurs no AGPL obligation whatsoever. The old
decision applied a library-shaped cost to an application, and overstated it as a result. The real
adoption cost is much smaller than it claimed.

**Why the CLA is not optional.** The old decision already noted that *"a project can relicense
forward while it has a single copyright holder. Once outside contributors hold copyright it
requires their agreement."* That is exactly the window we are standing in. Without a CLA, the
first merged outside pull request permanently ends the ability to dual-licence — which is the
mechanism by which a customer who cannot accept AGPL buys a commercial licence instead. The CLA is
set up **before** pull requests open in Phase 2 (`README.md`).

**What AGPL does not do, said plainly.** It does not prevent a competitor from hosting Purlay. It
requires them to publish their modifications, which deters most and stops none. Preventing
competing hosting outright requires a non-compete licence, and that is the next entry.

**Precedent worth naming:** this is the shape Plausible Analytics runs — AGPL source, an
affordable managed offering, no open core, explicitly not chasing growth. It is the closest
analogue to what D-1 describes, and it works.

**Rejected — MIT and Apache-2.0.** Both leave the cloud entirely undefended. Apache's patent grant
is genuinely better for corporate adopters, but that is not the axis that matters here.

**Rejected — BSL or another fair-source licence.** It is the strongest commercial protection and
it would work. It also means the project can no longer honestly call itself open source, and
`README.md`, `PRD.md` §2 and D-1's third audience all rest on that word. Trading the community
that makes the product credible for protection against a competitor who does not yet exist is the
wrong side of that trade.

**Reversibility:** forward relicensing stays possible only while copyright is consolidated. The
CLA is the thing that keeps it true, which is why it ships before contributions open.
