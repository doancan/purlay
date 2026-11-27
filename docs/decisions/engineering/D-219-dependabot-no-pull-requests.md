# D-219. Dependabot opens no pull requests; updates are the owner's — amends D-20, D-86, D-91

**Decided (the owner, 2026-10-31).** Dependabot opened pull requests on a schedule of its own and showed
up among the repository's contributors; the owner wants every pull request to be one a person chose to
open. So `.github/dependabot.yml` is removed — no version updates for Bun packages, the Docker bases or
the actions — and the repository's automated security fixes are switched off. Its **alerts** stay on: they
open nothing, and say only that an advisory touches a dependency.

What it watched is now watched by a person, and each place that said "the bot proposes it" means that:

- **The TypeScript 7 trigger (D-20)** — `typescript-eslint` supporting TypeScript ≥ 7.1 — is checked by
  hand when the toolchain is updated.
- **Image digests (D-86)** move only when the owner moves them; `scripts/environment.test.ts` still holds the
  tag, the digest's version and `packageManager` equal, so a half-done bump fails.
- **Action SHAs (D-91)** stay pinned and checked by `scripts/workflow-pins.test.ts`; a new release arrives
  as an ordinary pull request, not a bot's.
- **Advisories** are still found without a commit: `bun run audit:gate` runs weekly and blocks at high
  severity, and CodeQL runs weekly with new queries.

The `dependabot/` branch prefix and the bot's exemptions in `check-pull-request.ts` and
`contributor-agreement.ts` stay while a pull request it opened is still open (#785), so that one can still
be finished; they go with the last of them.

**Amended 2026-10-31.** #785, the last, merged; the prefix and both exemptions are gone, and a pull request
from the bot would now fail `check:pr`, `check:cla` and `check:branch` like anybody's without an issue,
a signature or a named branch.

**Considered and rejected.** Keeping the actions and Docker ecosystems monthly (still a bot's pull
requests, which is what was asked against); keeping security-fix pull requests only (the same). Rewriting
history to take the bot out of the contributors list (its eight commits are on main, and a force push to
main is not worth a name in a list).

**Cost of reversing.** Put `.github/dependabot.yml` back from history and switch automated security fixes
on again.
