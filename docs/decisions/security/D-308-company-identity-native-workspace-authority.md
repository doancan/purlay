# D-308. Keep company identity on native workspace authority and preserve the strict OIDC verifier

**Context.** Server-wide single sign-on does not provide each company with workspace-owned identity
configuration, domain proof, admitted-user bindings or employee lifecycle policy. Better Auth plugin
availability alone proves none of those. The actual-SQL and callback experiments in
`docs/spikes/workspace-identity.md` proved native transaction integration and also observed protocol
differences which prevent replacing D-200 with the bare SSO verifier unchanged.

**Decision.** Use workspace-owned, revisioned provider connections and domain proofs, the existing
credential cipher, and explicit immutable issuer/subject bindings to the existing canonical user.
Administrator operations obtain the existing workspace capability and recheck the current full-member
role under the workspace mutation lock. Guests and server administrators gain no private-chat or
company-administration bypass. Foreign objects remain indistinguishable from absent objects.

The first complete slice is optional company OIDC, including the administrator's domain/configuration
journey, an actual provider round trip before enablement, a member's explicit account enrollment,
company sign-in, disable/unlink and the associated audit and error states. A verified email suffix or
DNS proof never creates membership or silently links an existing account. An admitted, authenticated
person proves the company identity they choose to bind; later sign-in resolves that exact binding.
An invitation first establishes native admission through the existing verified invitation flow.
Subsequent directory integration resolves an exact active provisioning source in the native
transaction; email equality is not its identity key.

Reuse `apps/api/src/modules/auth/oidc.ts` for discovery, key rotation and all signature, issuer,
audience, authorized-party, nonce, token-age and PKCE rules. Better Auth state carries the exact
workspace, connection revision and server-chosen intent. A callback consumes its bound state cookie
and performs network verification before native finalization. Re-read and fence the persistent
connection, current account, session and membership inside the transaction; configuration change or
revocation while the IdP is answering must not revive old authority. Use the public exact-selected-user
finalization API inside the existing transaction bridge. Throw on a returned failure so it cannot
commit partial account or membership state; emit cookies only after commit. No provider token is
retained and existing session hashing, admission hooks and revocation remain authoritative.

DNS proofs belong to an exact workspace and canonical domain. A proof is not a provider-credential
test: domain ownership and successful client authentication are separate requirements for enablement.
Changing credentials invalidates their prior test and in-flight callbacks; it does not transfer domain
ownership. Proof renewal replaces the challenge revision. OAuth secrets are write-only and sealed to
their record. The administrator's intentionally public TXT record can be recovered after a refresh;
it is separate from provider credentials and never accepted as membership or a user identifier.

Contracts and bounds are owned by `packages/types/src/workspace-identity.ts`. Lists are bounded and
paginated, mutations name observed revisions, stale forms cannot overwrite replacements, and older
clients survive additive read fields. Keep current users, owners, guests, channel history and existing
server sign-in behavior intact. New operational session provenance must be captured atomically so
later policy/revocation can identify company-issued sessions without guessing from an account's email.

The complete #1372 scope remains: actual SCIM users/groups and source-aware native roles, employee
on/offboarding, enforceable sign-in/MFA/session policies, devices/session revocation, security settings
and usable audit/filter/export flows. These ship in complete reviewed slices; the optional connection
slice or a spike does not mark corporate administration or the notification/mobile matrix complete.

**Rejected.** A parallel organization membership table; user-provisioning after commit; implicit
same-email account linking; client-supplied user/subject/role mappings; discovery alone certifying a
client secret; bare SSO verification without preserving D-200; provider calls under native SQL locks;
assuming all Google plans offer outbound provisioning; representing plugin installation as a feature.

**Cost of reversing.** Disable company admission through its existing control and retain mappings,
audit evidence and additive tables. Existing users and chat data remain. No down migration, applied
migration rewrite or encryption-key rotation is required. An old binary does not enforce future
company policy, so a policy-bearing rollout must explicitly retain capable readers or close admission.
