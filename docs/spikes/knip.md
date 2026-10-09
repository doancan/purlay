# Spike — knip

**2026-10-09.** Run on the repository itself, with `knip` added as a root dev dependency. D-48
promised "`knip` runs in CI: an export nothing imports is wired up or deleted" and nothing ran it;
this is the record that it does, and what it cost (#136, D-57).

## Versions resolved

| | |
|---|---|
| Bun | 1.4.2 |
| `knip` | 6.39.0 — not 6.41.0, published the same morning, nor 6.40.0, three days old; a version this young is not pinned |
| Licence | ISC |

`bun add -d -E knip@6.39.0` installed 6 packages. Pinned exactly, like every other dependency.

## First run, no configuration

`bunx knip` took **1.7 s** and found 19 things:

| Finding | Count | What it was |
|---|---|---|
| Unused files | 4 | `apps/web/src/system-clock.ts`; three scripts run only by shell scripts inside the API image (`bucket-copy.ts`, `rehearsal-ready.ts`, `rehearsal-seed-bucket.ts`) |
| Unused dev dependency | 1 | `happy-dom` in `apps/web` |
| Unused exports | 5 | `clearedStateCookie` (a re-export), `SCOPES`, `GITHUB_ENDPOINTS`, `browserSocket`, `AREA_PATHS` |
| Unused exported types | 9 | six in the API, three in the browser's realtime client |

## What was done about each

**Deleted or made private (the repository's own dead surface):** the `clearedStateCookie` and
`HeldByConnections` re-exports (their only consumers import from the source module), the `export`
on `SCOPES`, `GITHUB_ENDPOINTS`, `AREA_PATHS`, `SocketHandle`, `UpgradeRefusal`, `TrackedError`,
`SocketGate` and `Visibility`, and the `happy-dom` pin — it is a dependency of
`@happy-dom/global-registrator`, nothing imports it, and the lockfile still resolves 20.14.0.

**Named, in `knip.jsonc`, each with a reason and an issue:**

- `scripts/bucket-copy.ts`, `rehearsal-ready.ts`, `rehearsal-seed-bucket.ts` — entry points run by
  shell inside a container; knip does not read shell (#274, #275).
- `apps/web/src/realtime/*.ts` and `src/system-clock.ts` — the browser realtime client and its
  clock. Finished, tested, and imported by nothing until the client store lands (#26). **This is
  the one exemption**; it is a single `entry` array, so it can be counted and it expires when #26
  merges.

## What had to be loosened

**Nothing.** No `ignore`, `ignoreDependencies`, `ignoreExportsUsedInFile` or `ignoreIssues` is set;
no rule type is turned off. Two entry lists, above, are the entire configuration. Knip found the
rest unaided: package scripts, the Vite config, `bun test` files, the ESLint config and
`exports` in `package.json`.

## What surprised us

- **The auto-detection was good.** Nothing needed telling about the API entry, the web entry,
  Vite or the test runner; of the 19 findings, four files were run by shell scripts it cannot read and the rest were real.
- **Entries listed in the wrong place are findings too.** A root-level `entry` is refused as soon
  as `workspaces` exists ("move unused top-level entry to one of workspaces"), and a `scripts`
  workspace key is refused because `scripts/` belongs to the root workspace. Knip reports its own
  misconfiguration as a hint but still exits 0 on hints alone (verified with a pattern matching nothing), so an entry that stops matching
  anything is silent — worth watching.
- **A test counts as an importer.** An export used only by its test passes. That is the right
  answer for a library and a weaker one for a leaf; the rule is "nothing imports it", and tests
  do.
- **Being an entry hides exports.** Naming the realtime client as an entry also stops knip
  reporting any *new* unused export in it. That is the price of the exemption and why it is one
  array that must go when #26 lands.

## Demonstration

`bun run verify:enforcement` plants a module with a used and an unused export plus a test that
imports the used one. It requires knip to be clean before the unused export is added, and to exit
non-zero naming it after. Run by hand the same plant gives:

```
Unused exports (1)
unused  apps/api/src/platform/zz_plant.ts:2:14
rc=1
```
