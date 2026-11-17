# Picomatch audit allowance — 2026-11-18

Owner: Görkem. Follow-up: [#1438](https://github.com/doancan/purlay/issues/1438).
Policy: D-91. The current allowance and its expiry are owned by `scripts/audit-allowlist.json`.

## Finding and versions actually checked

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) describes excessive regular-expression backtracking for single-branch repeated extglobs. The GitHub advisory API on this date reports `<= 4.0.7`, `first_patched_version: null`, updated 2026-11-17. The npm registry reports `latest: 4.0.7`. There is no published fixed release to install today.

Bun 1.4.4, frozen repository lockfile:

```text
bun pm why picomatch
picomatch@4.0.7
  Knip 6.41.0; Vite 8.3.5; tinyglobby 0.2.17; TypeScript-ESLint 8.72.1
picomatch@2.3.2
  micromatch 4.0.8 -> Kysely codegen 0.20.0
```

These paths start at development dependencies. The dependency versions and lockfile are unchanged by the allowance.

## Production-install experiment

Copied only the root manifest/lockfile and every workspace manifest into a new empty directory, with no inherited `node_modules`. Ran the exact dependency-stage command from `Dockerfile`:

```sh
bun install --frozen-lockfile --production --filter @purlay/api
```

Result: exit 0. Traversed installed package manifests, including Bun's physical package store, and found zero installations named `picomatch`, `micromatch`, `tinyglobby`, `vite`, `knip` or `kysely-codegen`.

Local receipt: `/tmp/purlay1438-production-install.log`; manifest-only experiment: `/tmp/purlay1438-production-proof-20261118`. This is a dependency-stage experiment, not a newly built production-image attestation. The already successful PR image build and restore rehearsal remain separate checks.

The runtime stage copies this production dependency tree and the built browser files; it does not copy the client build stage's dependencies. A source search found no direct imports of the affected glob packages in API/package production code. Development dependencies are still present while linting, building and generating types.

## Reachability, mitigation and accepted risk

The observed callers are Knip's repository configuration, Vite/tinyglobby's local project discovery, TypeScript-ESLint's project discovery, and Kysely codegen's database/table patterns. Their pattern configuration comes from developer commands and checked-in tooling configuration; application HTTP request bodies do not configure these tools. Existing build and lint commands were already verified for this unchanged dependency tree.

This does not prove the glob implementations safe. An untrusted project/configuration or malicious glob passed to these development tools can still deny service to a build process. Keep such execution in isolated CI with the existing job timeouts and read-only pull-request credentials. Do not execute untrusted checkout/tool configuration on a privileged development or production host. A production dependency or new user-controlled glob caller invalidates this assessment.

## What changed and what remains enforced

One exact package/advisory pair is temporarily accepted under the existing no-fix policy. This is an explicit acceptance of residual development-time risk. The high-severity threshold, audit status requirement, lockfile, dependency pins, expiry check, stale-entry check and maximum-allowance rule are unchanged.

The actual committed allowance must fail after its expiry, when its advisory disappears, and for an unrelated high advisory. Existing audit tests also prove that high/critical findings without matching allowances remain blocked. The live audit must report the exact temporary acceptance visibly.

Keep the follow-up open: install a maintained fixed release when available, rerun the tooling and production-install checks, remove the allowance, and demonstrate a clean audit. Expiry requires a new review; it must not be extended automatically.
