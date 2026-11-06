# Invitation follow-through: implementation and acceptance

Issue #1149; D-279. Built after server administration (#1147) and rebased onto its merged main commit.

- Separate bearer link for each queued mail recipient; the one-time copy link remains separate. Existing seven-day member semantics and durable daily quotas are preserved.
- Workspace-manager-only keyset recipient and attempt pages, persistent relay acceptance/safe failure, expiry, revocation and unconfirmed sends after 120 seconds. No inbox-delivery claim, stored token, body or raw SMTP diagnostic.
- Manual resend rotates only that recipient's link. Concurrent resend/revoke requests serialize on the prior invitation and recheck its latest attempt. Monotonic per-recipient UUID ordering also handles equal/backward clocks.
- Verified invitation sign-in attests only the matching recipient's applicant, including the direct email-link spend path. Acceptance attests matching verified recipients; forwarded bearer links do not invent a named recipient's join.
- Visible pending accounts refresh their restricted status automatically without renewing idle activity; the preserved invitation resumes after approval.
- Core table ownership, workspace purge, account erasure and personal export include recipient evidence. Workspace exports omit private recipient addresses/history.
- Migrations 0086–0087 are additive. The safety annotation of 0087 uses the existing comment-only checksum ledger; its executed SQL was not changed.
- English/Turkish feedback, retryable errors, empty/loading states, independent history pagination and narrow-screen actions reuse existing settings components.

## Verification

- Real SMTP acceptance/refusal, persistent receipts across app instances, resend, revocation, safe diagnostics, quotas and recipient isolation: 26 tests passed in the final combined HTTP/service run.
- Controlled concurrent SQL writers prove that waiting resend/revoke requests cannot affect a replacement they never saw.
- Real-browser invitation email → verified account → pending approval → administrator approval → same invitation without Refresh → joined. Separate-recipient resend/revoke, history, reload persistence and unchanged other links also passed.
- Final targeted Playwright run: 4 passed, including standalone administration and both initial-socket-open regressions. Invitation layouts checked at 1440/390/320 CSS px in light/dark, without horizontal overflow or axe A/AA violations. Screenshots reviewed; narrow actions were moved below the full-width address.
- Both TypeScript compilers, ESLint, Knip, formatting, documentation references, environment/token generation and all 83 enforcement demonstrations passed. Mutation anchors preserve the existing guards after the service changes. Generated schema matches a migrated throwaway database byte for byte.
- Final mapped build: 248.13 KB initial JavaScript gzip. Final Docker image built successfully. Linux process RSS on an isolated cloned database with the repository's memory-budget configuration: 105.99–106.54 MiB, below 120 MiB. ACK/fan-out quiet p95: 25.0/24.8 ms; busy issue workload: 33.6/32.7 ms, within the existing budgets.

The native full run reported 20,553 passed, 2 skipped and 13 failed, with 99.88% functions / 99.74% lines; every file met the unchanged coverage floor. Eleven settings failures were caused by a local benchmark importing its temporary provider into the shared test database; only that identified row/code were removed, the benchmark was moved to its own clone, and the affected settings plus migration-safety rerun passed 58/58. The migration annotation failure was corrected through the checksum ledger; migration/schema tests passed 54/54. The remaining native idle-RSS assertion was 132.98 MiB on macOS; the budget targets Linux, where the final image passes at 106.54 MiB. No threshold or test was weakened. GitHub's Linux CI is the final gate.

## Related realtime issue

#1071 was already implemented by #1106. Verified 132 engine tests and both real-browser regressions, then closed the stale issue with that evidence; no duplicate implementation was added.
