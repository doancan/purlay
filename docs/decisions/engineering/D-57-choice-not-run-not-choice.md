# D-57. A choice that has not been run is not a choice

Three defects in a row had one shape. D-54: the branded type `ARCHITECTURE.md` §7.3 specified was
uninhabited — it could never have compiled. D-55: Turborepo was in the stack table and had never
been installed. D-56: the table named a web framework version while nothing had installed the
framework. Each was written down as decided, and each was a guess.

The count, taken before fixing it: **19 rows in the stack table, 6 of which had ever been run.**
One of the remaining thirteen did not even name a package — *"a small CommonMark/GFM renderer"* sat
there as though it were a choice.

**So a tool enters the stack table on a spike record, not on an argument.** `docs/spikes/` holds
one file per tool, carrying the date, the versions actually resolved, the commands and their real
output, and what had to be **loosened** to make it work. `CONTRIBUTING.md` §6.7 states the rule;
the directory is where the evidence lives.

**"Nothing was loosened" is stated explicitly, never by omission.** Silence there is
indistinguishable from not having looked, and this project already treats absence as
non-evidence (§6.4).

The first two records exist because the two riskiest claims were finally run. Both hold, both
needed nothing loosened, and both **found things the documents did not know**: ElysiaJS's own
declarations produce 104 errors under this project's strictness, so its compatibility is contingent
on `skipLibCheck` (recorded on D-20's risk row); the web skeleton consumes a third of the bundle
budget before a product screen exists; `happy-dom` alone cannot render a component; and `apps/web`
was compiling zero `.tsx` files while reporting success.

**Rejected: installing everything now to make the table true.** Thirteen dependencies nobody uses
yet, each with an upgrade and audit cost, to answer a question a scratch directory answers for
free. The spike produces the knowledge without taking on the debt.

**Rejected: a checklist item.** A box beside "did you actually run it" is the theatre `CONTRIBUTING.md`
§6.2 forbids. The mechanism is that the record has to exist and say what it cost.
