# D-185. `main` is the one branch, a merge deploys, and a release is a version someone chose

*Amended by D-229 and on 2026-11-09: Actions publishes tested releases on hosted runners; Dockhand applies them (D-262). No workflow runs on the production host.*

**Decided (the owner, 2026-10-26), builds on D-73, D-86, D-92, D-94 and D-95.** How a change reaches the
team's server, and what a release is, were a list of commands run by hand: build on the server (the Mac
cannot, D-92), copy the source, change `PURLAY_IMAGE`, `up -d`, look.
**Amended 2026-10-27:** use the image published by CI rather than rebuilding on production; keep the
Docker and deployment files in this repository. First installation is in `docs/DEPLOY.md`. Now:

- **One long-lived branch.** Work happens on `feat/`, `fix/`, `chore/`, `refactor/` and `docs/` branches and
  reaches `main` by a pull request that passes the required checks. There is no `develop`.
- **A merge builds; a release is published after its checks pass.** The `deploy` workflow listens to
  `ci` and `image`, checks both push runs of the exact commit on `main`, and verifies main ancestry on
  GitHub's hosted runner. Its release job checks out that same commit. No Actions workflow connects to
  production or requires a self-hosted runner. Dockhand follows `:release` when configured (D-262);
  image publication is not a claim that a particular server is running it.
- **A failure goes back the way `ARCHITECTURE.md` says.** A Dockhand upgrade needs the dump from before
  the migration and the previous image; there is no automatic restore at its switch (D-262). An operator
  managing Compose directly can still invoke `scripts/deploy.sh`: verify the commit's CI results, pull
  and verify its image, back up, switch and check the running revision. That script restores its own
  backup on failure. No data volumes or recovery procedures are removed with the Actions runner.
- **A release is a version, and merging a pull request makes it.** The root `package.json`'s `version`
  is its one home. `bun run release -- minor` opens the version and changelog pull request. Once that
  commit's own checks pass, `scripts/release-publish.sh` publishes its tag and GitHub Release. A merge
  that leaves the version alone publishes nothing new. A hand-started workflow can retry publication
  after the same gate; it performs no server deployment or rollback.
- **The changelog is in one shape.** Keep a Changelog: **Added, Changed, Deprecated, Removed, Fixed, Security**,
  one line per bullet, with a bold area and the decision in parentheses, so that a person scans a release in two
  minutes instead of reading a transcript. `changes.md` says how to write an entry; `scripts/changelog.test.ts`
  holds the files to it and `bun run release` refuses an Unreleased that is not. What was written before the
  first release, in prose, is kept as it was (`docs/changelog/pre-0.1.0.md`).
- **The workflow boundary is held by a test.** `scripts/deploy-workflow.test.ts` refuses a self-hosted
  runner, an unchecked commit, or publication without the successful gate. Only the release job writes
  repository contents; the separate image promotion workflow writes packages.

**Considered and rejected.**

- *A `develop` branch (GitFlow).* It answers a question this product does not ask — several versions
  supported at once — and costs two merges and two CI runs per change, a branch that drifts from `main`, and a
  third path for a fix. If a stop before production is wanted, an approval on the deploy is cheaper than a
  branch.
- *A version number per merge* (release-please, semantic-release). With one server and no outside users, it is
  a number nobody chose, and it fights a changelog written by hand under *Unreleased*.
- *Deploying only on a tag.* One environment and a team using it is the feedback this phase exists for (S-1);
  waiting for a tag delays it for no safety the checks and the backup do not already give.
- *Connecting hosted runners to production.* The server remains private. Hosted runners publish
  artifacts instead; Dockhand polls GHCR without exposing its control panel.
- *Running the old image to go back.* It refuses the newer schema (D-86); this was reproduced, not reasoned.
- *Publishing to GHCR as part of this.* `image.yml` and `scripts/release-image.sh` (D-92) stay as they are: that
  is how a self-hoster gets an image, and nobody is waiting on it for the team's server.

**Accepted.** CI cannot prove that a private Dockhand instance applied an image. Readiness and the
running image revision must be checked there. A migration can still pass tests and be wrong; the backup
remains the recovery path. Concurrent publication is serialized and an already published version is a no-op.

**Cost of reversing.** Restore a server deployment job if that installation needs it; the direct Compose
script and recovery runbook remain available. Changelog entries merged after a release pull request was
opened still require regenerating that release with `bun run release`.
