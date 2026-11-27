# D-310. Workspace policy consumes native authentication evidence without creating another authority

**Context.** A company provider controls only its retained workspace origin (D-309).
Workspace owners need company sign-in, MFA and session-age requirements without acquiring
control of global credentials, reviving old proofs or locking every owner out.
The pinned native MFA probe showed that native factors are global and that a successful
native same-code verification alone is not a consumed workspace assurance.

**Decision.** Keep native users, sessions and memberships canonical. Capture the actual primary
method/time and company origin atomically with native authentication. Legacy or unobserved
proof remains unknown; provider `amr`/`acr` is not accepted. Native handoff requires a live
same-user source and copies original primary/MFA times and all workspace assurance state,
including expiry and ending. Retained source IDs have no cascading foreign key. Deleting a
provider, factor or source cannot turn company/unknown evidence into independent authority.

Company sign-in is required only for full members; restricted guests retain independent
sign-in. MFA, idle and primary-age limits also apply to guests, with the same narrow own-factor
remediation and existing channel/history bounds. Policy preview counts both member and guest
impact. There is no silent guest MFA exemption and no new sign-in-scope toggle.

An owner previews, performs a real revision-bound policy test and then enforces the tested
policy. Persist a monotonic workspace epoch even when the policy row disappears; missing or
mismatched governed state fails closed. An assurance binds workspace, native session/user,
authentication revision, policy epoch/revision and actual factor revision/time. Store its
base deadline, separate MFA deadline and workspace activity. The base deadline is bounded by
native expiry, primary age and workspace idle time; MFA expiry can be refreshed only by an
actual accepted verification while that base remains live. Expired or ended base evidence cannot be revived by relaxing or
replacing policy. Activity extends idle expiry only while the old proof is still valid.
HTTP, native handoff, WebSocket projection and final push handoff repeat the same authority.

Scheduled sends, reminders and archive requests retain the exact native author session ID.
The nullable source has no foreign key or backfill: losing a source cannot turn known company
authority into independent authority. Legacy jobs without provenance can serve only ungoverned
workspace content. Explicit newly authorized edits/rescheduling can bind a new actual source;
workers never choose another live session or manufacture primary authentication. Personal
archives evaluate each workspace independently, omitting blocked workspaces while preserving
eligible ones and independent account data. Core migration 0113 adds export provenance;
chat/0017 adds schedules/reminders only where chat runs.
Prepared personal archives additionally retain their exact included workspace IDs (0114):
NULL means legacy unknown and an empty array means proven account-only. Atomically bind the set
to READY and its per-run storage key; an older competing run cannot overwrite a winning tar.
Download rechecks the original source against that exact set before releasing any archive bytes.

Canonical content SQL fences the shared access decision by its actual native source, retained
epoch, policy/evidence/assurance/factor revisions and deadline. A copied fence is rejected.
Initial membership and private-resource visibility are checked separately before a scoped
verification hint can be returned. Safe own-membership metadata remains discoverable for
remediation; it grants no channel, message, file or people inventory access.

Use workspace-owned sealed TOTP for company sessions, with no fabricated password and no
permission for global credential endpoints. Real captured independent global MFA may satisfy
policy, subject to its current factor revision and original verification time. Reuse the pinned
native HOTP primitive rather than implementing another TOTP algorithm. Shared contracts set
six ASCII digits, a thirty-second period and a thirty-two-byte secret. Verification consumes
the actual matched counter atomically; counters do not decrease. Native factor revisions
change with meaningful material/state; only a changed native secret resets its counter.
Workspace factor IDs/owners/secrets are immutable, state progresses towards revocation, and
rotation creates a new row. Seal with stable workspace/user/factor-ID associated data, since
state transitions change the revision. Purpose-bound challenges/tests store token hashes,
expire quickly and bind the exact native session owner, authentication, policy and factor.

Recovery is a fresh independently authenticated current owner plus a single-use policy
recovery code. It changes policy metadata only and grants no membership or content authority.
A provider-only sole owner establishes that recovery path or adds a recoverable owner before
enforcement. Normal company sessions can manage only their own bounded workspace factor.

Lock source session, workspace, user/member, policy, factor/counter, challenge/recovery and
assurance in that order. Provider I/O never holds these SQL locks. Account erasure explicitly
removes workspace factors and recovery codes, since native membership tombstones remain;
source-linked evidence follows session cascade. Secrets, raw receipts and recovery codes are
never logged or exported. Additive migrations 0108–0112 preserve existing data and defaults.

As for guest admission (D-300), `WORKSPACE_ACCESS_READY=false` is an explicit operator rollout
attestation, not a workspace-owner setting. Enable it only after every API, scheduler and
job/outbox reader runs a capable release. The API additionally advertises `workspace-access`
capability in its own shared node record and rejects enforcement when a known live API peer
is behind or that registry cannot answer. No Redis, no live peer or an empty registry proves
worker readiness. Capable CLI jobs and schedulers check migration history before work; an
older binary that predates that check remains unsafe and must be removed by the operator.
Secured recovery and disabling enforcement remain available while readiness is false; neither
operation revives expired proof or grants content. Retain capable readers while any governed
workspace exists, even if new enforcement is disabled.

**Rejected.** Another login/session/membership store; email or provider claims as MFA proof;
resetting a retained epoch; treating a missing policy as implicit off; cloning native global
factors for company authority; one-shot TOTP replay; extending already-expired assurance;
recovery codes that bypass membership/content guards; changing applied migrations.

**Cost of reversing.** Expand schema and readers while enforcement is off. Enforce only after
the operator has verified all configured readers and final output paths, with no known incompatible API peer. Roll back to a
compatible schema-aware reader or close admission; retain epochs, evidence and audit records.
An older reader that ignores policy is not a safe rollback. The remaining full corporate scope
of D-308, including provisioning and scoped roles, remains separate from this vertical.
