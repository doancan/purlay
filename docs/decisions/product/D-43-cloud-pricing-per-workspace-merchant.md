# D-43. Cloud pricing is per workspace, not per seat, and sold through a merchant of record

**Per-workspace pricing, with a generous included seat band.** D-2 lists *cost* as one of the four
axes Purlay competes on, and `README.md` says it in the first paragraph: no per-seat cost. A cloud
that then charges per seat would contradict the product's own headline and hand every reader a
reason to distrust the rest of it. Charging by workspace keeps the claim true: **adding a
teammate never costs more**, which is a real differentiator against Slack rather than a slogan.

*Rejected: per-seat pricing.* It is the obvious model and it is the one that makes the positioning
a lie.

**Sold through a merchant of record** — Polar, Lemon Squeezy or Paddle — rather than Stripe
directly. Selling software to teams worldwide from a Turkish entity means EU VAT, UK VAT, US sales
tax nexus and invoicing rules in each. That is not engineering; it is a permanent compliance load
on one person, and D-1 already accepted enough non-product work. A merchant of record becomes the
seller and absorbs it.

*Accepted cost:* a higher percentage than Stripe, less control over the checkout, and a dependency
on a smaller company than Stripe. **Trigger to revisit:** when the fee delta over Stripe's rate
exceeds the annual cost of tax compliance tooling and an accountant, migrate. A number, not a
feeling (D-17).

**Priced to be boring.** The number covers infrastructure, the merchant-of-record fee and the time
to operate it, with enough margin to fund development — and not more. D-1 fixed the size of this
business deliberately, and pricing is where that decision either holds or quietly stops holding.
The target customer is a team that finds Slack expensive; arriving with a price they also find
expensive would be an odd way to compete on cost (D-2).

**Metering is per workspace and per month**, and the numbers that matter are already columns:
`storage_used_bytes` (D-16) and the member count. No new usage-tracking subsystem.
