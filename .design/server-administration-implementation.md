# Server administration implementation and acceptance

Goal: implement the gaps in server-settings-gap-research.md properly, fixing defects found. Work is on feat/server-administration, initially based on 982e1e8b and rebased onto 7660efcb before opening the pull request. This checklist records the whole scope, not merely the first delivery slice.

- [x] Shared strict request/response contracts; admin guard before parsing; no secrets/content in answers.
- [x] Independent console and entry without a workspace; nine coherent sections; legacy entry compatibility.
- [x] Overview: version, real readiness, enabled modules, deployment capabilities and aggregate counts; configured is distinct from checked.
- [x] Paginated users, filters, account details/memberships, suspension, audited administrator grant/revoke with concurrent last-admin protection; revoke sessions closes sockets after commit.
- [x] Global workspaces, owners/counts/deletion status; quota editing uses existing service and counts upload reservations.
- [x] Server audit: filters, dates, keyset pagination; distinct from workspace audit; no raw secrets/errors.
- [x] Operations: actual enabled job catalogue/status, stale/never/failing states; retention/export visibility.
- [x] Email: structured SMTP inputs and saved-connection test without secret re-entry; relay acceptance clearly described; truthful last test.
- [x] Security: verified-domain admission policy and approval workflow, enforced consistently for registration/invitations/OAuth/OIDC; existing accounts grandfathered.
- [x] Server identity/support settings with validation and public use; deployment URL stays read-only.
- [x] Backup status from a trustworthy operator receipt/source; unreported and restore-unverified states explicit; no browser restore.
- [x] Categorized identity/email/integrations reusing existing settings; deployment/push/storage inventory read-only.
- [x] DB and HTTP permission/race tests, web state/navigation tests, desktop/mobile/keyboard real browser checks; relevant repo checks pass.

Not requested: SAML/video/plugin marketplace, arbitrary shell jobs, live editing of DB/encryption/S3/VAPID credentials, overriding owners' retention policies or destructive one-click restore.

## Acceptance evidence — 2026-11-06

Implemented the complete checklist above. Tracking issue: https://github.com/doancan/purlay/issues/1146. Source decisions and deployment instructions are D-278, API.md, CONFIG.md and DEPLOY.md.

- HTTP integration scenarios cover guard-before-validation, bounded/literal inventories, pagination, metadata-only answers, deleted accounts, quota reservations, audit filtering and last-admin concurrency. Role loss while a settings change waits and erasing the last administrator both have regression tests. Approval is exercised through GitHub, Google, OIDC, invitation passports and real email links.
- `apps/web/e2e/server-administration.e2e.ts` and `server-settings.e2e.ts`: **2 passed** against isolated real servers. Saved SMTP uses a real loopback relay and persists its receipt across reload; the new email account remains restricted until the administrator approves it; the same session then enters the app. Quota changes, identity/support, audit filtering, narrow controls and keyboard navigation are included.
- Independent headed Chromium audit: **36 checks** (nine sections × light/dark × 1360/320 CSS px), **0 API/page errors, 0 horizontal overflows, 0 axe WCAG 2/2.1 A/AA violations**. Keyboard navigation closes the mobile menu and focuses the new main content. These are Chromium results, not a Safari/Firefox claim.
- Full unit/integration run: the manifest-pinned Bun runtime, PostgreSQL and Redis, process-scoped IPv4 database host; **20,426 passed, 2 skipped, 3 failed**, 108,788 assertions, 750 files. Coverage **99.88% functions / 99.74% lines**, with **every file meeting** the unchanged 95%/96% floors. Two failures were production/Dockhand environment comparisons after adding the optional receipt variable. Both were corrected and the combined production/Dockhand/admission rerun passed **44/44**. The only remaining native-platform failure is the macOS idle-RSS assertion described below. No tests or thresholds were removed to obtain these results.
- Production Docker image built successfully. Actual Linux API memory after readiness/settling, measured by Linux `ps` through `docker top`: **110,604,288 bytes / 105.48 MiB**, below **120 MiB**. An earlier run of the process metric measured 102.89 MiB. macOS `ps` reported **134,529,024 bytes / 128.30 MiB**; `scripts/budget-api.ts` explicitly documents that its gate is measured on Linux and macOS reports a different footprint. The native test still fails honestly; Linux deployment measurement passes.
- Generated Kysely schema compared byte-for-byte against a migrated throwaway database: identical. Append-only migrations 0082–0085, online index safety and upgrade/composition tests are included.
- Both TypeScript compilers, ESLint, Knip, formatting, document consistency, generated environment/token checks, all 81 enforcement demonstrations, mapped production build and JavaScript budget passed. Final initial JavaScript: **247.92 KiB gzip**. Latency checks passed: busy-workload ACK/fan-out p95 about **22–25 ms**, below their 120/200 ms limits.

- After rebasing onto current main: **203 tests passed, 0 failed** across 16 files (HTTP administration, module seams/frame handlers, UI states/navigation, admission, SMTP, account menu, contracts and both Compose deployments). Both TypeScript compilers, document consistency, branch naming, mapped production build and JavaScript budget passed again.

## Local review

The real local server remains at http://localhost:4180/server, with a signed-in headed browser. Its isolated preview database has the administrator, one pending applicant and one approved sample account. Saved SMTP testing uses only the loopback test relay. This does not claim production mail delivery or a production backup/restore check.

The preview launcher is `apps/api/src/testing/fresh-server.ts`; its manifest is `/tmp/purlay-server-admin-preview-20261106.json`. The user's development databases, `.env`, `.env.test` and unrelated `.superpowers/` directory were not modified. The global Bun installation was not changed; the repository-pinned Bun runtime used for final validation lives in a temporary directory.
