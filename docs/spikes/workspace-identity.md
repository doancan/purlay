# Spike — company identity over Purlay's native authority

**Date:** 2026-11-12. **For:** D-308, #1415 and the complete company-chat goal #1372.
**Verdict:** reuse the existing strict OIDC transport and Better Auth's public transaction,
account-finalization and cookie APIs. The bare SSO plugin does not preserve all of D-200 unchanged.
SCIM's exact active-source lookup can participate in the same native transaction. This is integration
evidence, not a delivered provider catalog, enrollment policy, administration screen or SCIM directory.

## Resolved and exercised

Scratch packages: Better Auth, its core, SSO and SCIM plugins at 1.7.14, Kysely 0.29.7; Bun 1.4.4 on
macOS arm64. Existing application source was the runtime merged as adcbb765. The scratch harness used a
clone of the actual Purlay schema, its existing transaction bridge, native workspace memberships,
membership guard and session-token hashing. The existing strict IdP fixture served real discovery,
JWKS and token requests on loopback. Only the external IdP was faked. Each owned clone was dropped.

Three experiments were run: directory projection alone; the SSO plugin's resolver with native
projection; and strict-native, combining the existing verifier with public native finalization. The
private harness files and JSON evidence are retained by the implementing operator. They are not
production dependencies or portable repository test fixtures; those regressions belong in the slice.

## Observed plugin integration gaps

The bare SSO authorization URL omitted nonce. Its callback accepted a mismatched nonce, a token signed
by a published ES256 key while discovery offered only RS256, a future issued-at value and a token older
than Purlay's existing maximum age. These are differences from the application's existing contract,
not a blanket claim about the library's security.

A server challenge bound to hashed state and provider, consumed inside the native transaction, fixed
the nonce comparison in the experiment. It did not fix algorithm narrowing or token-age enforcement.
Adding a nonce wrapper alone is therefore insufficient. The existing OIDC transport already owns these
checks and was reused in the final experiment instead of introducing another verifier.

## Strict transport and native finalization

The final harness used the public APIs for state and nonce generation, state-cookie parsing, native
transactions, exact selected-user account finalization and post-commit session cookies. It combined
these with `createOidcProvider` in `apps/api/src/modules/auth/oidc.ts`,
`rememberingTransactions` in `apps/api/src/modules/auth/sign-up-transaction.ts` and the real workspace
guard. Discovery, token and JWKS requests asserted that no native transaction was held.

The command and terminal result in the private scratch directory:

```text
$ python3 run-strict.py
strict_spike_exit_code 0
proof: purlay-strict-oidc-public-better-auth-native-finalization
finalized: 3
networkCalls: 20
no_verification_rule_loosened: true
```

Observed refusals left account, session and native membership state unchanged and emitted no session
cookie: mismatched nonce; an algorithm absent from discovery; future or over-age tokens; bad
signature, issuer or audience; missing authorized party with multiple audiences; unverified email;
another subject sharing the same email; a wrong callback issuer; a missing state cookie; and changed
fixture configuration at callback entry or after IdP verification.

Separately reached faults in native projection, session insertion and after successful account/session
finalization rolled all database work back. A good repeat sign-in retained one canonical account;
provider tokens were not retained, session tokens were hashed, and replay could not add a session.

The combined directory/SSO experiment exercised actual SCIM POST, GET and PATCH handlers on this same
Purlay schema. A reached native projection failure rolled back directory state and membership. An
existing OIDC account could not bypass its disabled exact SCIM source. Disabling one directory
preserved the second native workspace and shared sessions; reactivation restored admission. Disabling
the last active source ended sessions without deleting the canonical account. Cross-directory reads
returned 404 and missing credentials returned 401.

## What was loosened and what remains unproved

No production verification rule, compiler setting, threshold, migration or account was changed. The
scratch harness uses fixture-only configuration revisions and explicitly prepared canonical identity
mappings. It has not been independently checked by both repository TypeScript compilers or held to
all repository lint rules; Bun's execution is not a substitute for those gates. No claim is made for
the full application's hook/policy integration from the smaller options object used in this spike.

Production still needs persistent configuration fences and row locking, explicit person-authorized
enrollment, current account/session/membership checks, role and last-owner protection, source-aware
directory groups and grants, lifecycle/export handling, race regressions, bounded volume measurements,
real browser UI, independent runtime review and the complete required CI/release path. Google
Workspace provisioning availability must be checked for the actual provider plan. The complete goal,
including notification/mobile acceptance and enforceable company policies, remains open.
