# D-1. Purlay ships two ways: self-hosted open source, and a cloud we operate

*Amended by D-197: A phase ends on what is built and verified, not on the owner's team switching.*

Amended 2026-09-09. The original decision said *not a SaaS* and ruled out billing, metering,
trials, support and an uptime commitment. That is no longer the plan, and this decision is
rewritten rather than patched — everything downstream of it was written against the old answer.

**Four audiences, in priority order:**

1. **Dogfood** — the maintainer's own team replaces Slack with it. Still the only audience whose
   opinion can *kill* a feature. A feature the dogfood team will not use does not ship because a
   prospect asked for it.
2. **Cloud customers** — teams who pay us to run it. They fund the work and they set the
   reliability bar, but they do not get to add surface area the tenets refuse (D-2).
3. **Self-hosting community** — teams who run it themselves, for free, forever. Not a funnel and
   not a lesser tier: they are the distribution channel and the reason the product is trustworthy.
4. **Portfolio** — the codebase is a work sample. Drives code quality standards.

**No open core.** Everything the cloud runs is in this repository under the same licence. There
is no paid tier of features held back from self-hosters, and there never will be — the only thing
the cloud sells is *that we operate it*: backups, upgrades, monitoring, incident response and
somebody to email. Crippling the free product to sell the paid one would destroy audience 3, and
audience 3 is what makes audience 2 believe the data is portable.

**Amended 2026-11-02 (D-250).** The cloud may price what it operates by the modules a customer runs. Nothing is held back from a
self-hoster, who can run every module free; "the only thing the cloud sells" reads as *the operation of what the code does*.

The billing and metering modules live in the same repository, ship disabled by default, and are
inert in a self-hosted deployment.

**Consequences — things we now DO build, and did not before:** subscription billing and invoices ·
usage metering · a trial or free tier · transactional email · a support channel · a status page ·
backups with point-in-time recovery · incident response · an on-call expectation · a data
processing agreement and a subprocessor list (D-28).

**Consequences — still refused:** a sales-led enterprise motion · multi-region infrastructure ·
open core · a SOC 2 or ISO programme *until a customer contractually requires one*, at which point
it is a business decision and not an engineering preference (D-28).

**The cost, stated plainly because the original decision warned about it.** D-1 previously
rejected paying customers on the grounds that it *"would force ~40% of the engineering budget into
non-product work."* That estimate was not wrong; it is now **accepted rather than avoided**.
Billing, email deliverability, uptime, backups and support are real engineering, and they compete
with the product for the same hours. Phasing exists to keep that cost from arriving before there
is a product worth charging for: **nothing in this list is built before `v0.2.0` ships and the
dogfood team has stayed off Slack for thirty days.**

**The size of the business is itself a decision.** This is a small, sustainable operation funded
by people who would rather not run a database — **not a growth-stage SaaS**. That is a constraint,
not modesty, and it forbids things a venture-funded competitor would do: no sales team, no
enterprise motion, no upsell pressure on self-hosters, no usage-based pricing designed to grow
with a customer's success, and no feature held back to create an upgrade path (D-43). The cloud
exists to pay for the work and to serve the persona in §1.1 who wants the product without the
server. If it ever needs to grow faster than that, the honest move is to revisit this decision in
writing rather than to let the pressure leak into the product.

**Rejected — a separate hosted fork.** Two codebases diverge, and the divergence always lands on
the free one. One repository, one schema, feature flags where behaviour genuinely differs.

**Reversibility:** shutting the cloud down is cheap — the self-hosted product is the whole product
and survives untouched. Adding the cloud later would have been cheap too; multi-tenancy (D-3) was
retained precisely to keep this door open, and that bet paid.
