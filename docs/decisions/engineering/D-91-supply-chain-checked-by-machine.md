# D-91. The supply chain is checked by the machine: pins, audit, scanning, licences

*Amended by D-219: Dependabot opens no pull requests; updates are the owner's.*

The documents claimed every image and action was pinned; the workflow named `actions/checkout@v7`,
a tag its owner can move to code that then runs with the repository's token (#247). The dependency
tree carried five advisories (four high) that nothing reported, and nothing checked that a
dependency's licence could ship inside an AGPL-3.0 distribution. Each of those is a rule that was
true only while somebody remembered it.

**Decided: each is a failing check.**

- **Actions are pinned to a full commit SHA with a trailing `# vX.Y.Z` comment.**
  `scripts/workflow-pins.test.ts` fails any `uses:` that is not 40 hex digits plus a version
  comment, so it fails in the pull request. Dependabot's github-actions ecosystem was on (D-219 turned it off), so a
  new SHA arrives as the owner's reviewable bump instead of a silent tag move. The repository setting
  `sha_pinning_required` is the second lock, applied by the maintainer, not by a pull request.
- **`bun audit` blocks at high severity** (`scripts/audit-gate.ts`, run by `bun run audit:gate` in a
  job of its own). A finding that cannot be fixed goes in `scripts/audit-allowlist.json` with an
  advisory id, a reason and an **expiry date** no more than 180 days out; the gate fails on an
  expired entry and on an entry that matches no finding, so an allowlist cannot become a place
  findings are forgotten. It also runs weekly, because an advisory arrives without a commit. The
  current findings, reasons and expiry dates are owned only by `scripts/audit-allowlist.json`.
  **Reviewed by Görkem, 2026-11-18:** the no-fix picomatch development-tool finding follows this policy;
  `docs/spikes/picomatch-audit.md` records the exact production-install exclusion experiment, dependency paths,
  residual build-time risk and owner follow-up. Expiry and stale-entry failures remain required.
- **CodeQL scans JavaScript and TypeScript** on pull requests, on main and weekly, with read-only
  permissions except the one write it needs to report. On a private repository without Advanced
  Security it cannot upload results, so the job fails on any result in the SARIF itself.
  `scripts/workflow-permissions.test.ts` holds every workflow's top-level token to read.
- **A licence is checked against AGPL-3.0 distribution** (`scripts/licenses.ts`) over the installed
  tree, as an **allow-list**: an unknown licence fails, and so does a package that declares none.
  The workspace manifests state `AGPL-3.0-or-later` — what `NOTICE` grants ("version 3 ... or any
  later version"); `LICENSE` is the licence text and does not choose, and a test binds the two.
- **`SECURITY.md` and `CODEOWNERS`.** Reports go through GitHub's private vulnerability reporting
  (a public-repository feature), and the response targets are the ones one maintainer can keep.
  `CODEOWNERS` names the one maintainer so review is *requested* on every path. Branch protection
  stays strict with `enforce_admins` and **zero required approvals** — deliberate for one
  maintainer, since a required approval nobody else can give is a lock only the owner holds.
  Repository settings (alerts, security updates, secret scanning, SHA-pinning required) are
  applied by the maintainer, not by a pull request, and each is listed with its reversal.

**Rejected: tag pins with Dependabot only.** It reports a moved tag never; it only proposes the next
one. **Rejected: failing the build on any severity.** A moderate finding in a dev-time tool that has
no fix would block every merge for something with no exploit path in the product; the threshold is
a number in one file and moves down when the tree is clean. **Rejected: a third-party scanner
service.** Another account, another token, and a dependency of the pipeline itself; `bun audit`
and CodeQL are already in the platform we run on.

**Reversibility:** free. All of it is workflow and script; nothing is stored.


*Amended 2026-10-09 (a second-round audit):* every `actions/checkout` left the job's token in
`.git/config`, where any later step — an installed package's script included — can read it. No job pushes,
so none keeps it: `persist-credentials: false` everywhere, and `scripts/workflow-pins.test.ts` fails a
checkout without it (shown failing on nine before the change).
