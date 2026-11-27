# D-74. A pull request names its task, fits a measured budget, and stays in its area

Scope creep inside a task is how debt arrives unreviewed: asked to fix X, a change also reworks Y, and
the review that would have caught Y is now too large to do properly (#126). CONTRIBUTING said *one
issue, one pull request*; nothing checked it.

**Decided: three rules, run by CI on every pull request** (`scripts/check-pull-request.ts`):

- **It names its task** — `Closes #n`, or `Part of #n` for a task that takes several pull requests.
  Dependabot is the one author excused, its changes being the manifests every task may touch.
- **It fits the budget: 400 changed lines of production code.** Measured, not chosen: of the 32
  pull requests merged before the rule, the largest focused one changed 357; half changed under 120.
  Tests, documents and generated files are not counted — counting tests would charge a change for
  being well tested. Over budget passes only with the `large-change` label, so the size is a decision
  the reviewer can see rather than one they discover.
  *(Removed 2026-11-25, at the owner's request: a feature is as large as it is, and a size rule that
  every feature had to wave through taught nothing. The other two rules stand; the `large-change`
  label is no longer read.)*
- **It touches what its task is about.** The issues it names carry area labels, each allowing some
  paths; `infra`, `testing` and `security` are cross-cutting and restrict nothing. A file outside
  every allowed area fails, with no label to wave it through: split the change, or name the issue
  the file serves.

Run against the eighteen pull requests merged that day before it existed, it refused two — both
rightly, each naming its issue only in prose — and passed the rest, dependabot's included.

**Rejected: counting every changed line.** It punishes tests and documents, the two things this
repository most wants a change to carry.

**Rejected: an override label for the area rule.** Being over budget can be a deliberate decision;
touching another area's files under one issue is exactly the bundling the rule exists to refuse.
