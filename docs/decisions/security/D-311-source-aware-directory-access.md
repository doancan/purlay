# D-311. Project source-aware directory access into native workspace authority

**Context.** Corporate onboarding and offboarding need to distinguish manual access from each
directory's contribution without creating another account, membership or session authority.

**Decision.** Native users, workspace membership and channel membership remain authoritative.
Retained admission controls initialize existing manual provenance once under the workspace
mutex; later projected rows never manufacture a new manual source. Manual and exact directory
sources contribute independently. Directory admission grants only ordinary full membership,
never owner, administrator, guest promotion or global account/credential authority.

Workspace access groups are distinct from personal sidebar folders. Group membership names an
existing admission source and its canonical person. Custom roles contain only `members.invite`,
`members.manage_nonowners`, `audit.read`, `channel.settings.manage` and
`channel.members.manage`. A grant applies to its explicit workspace or visible non-DM channel
and only the role's compatible actions; it does not create admission or channel membership.
Delegated member management cannot target a native owner or administrator. Private resource
visibility remains independently guarded. Source and role changes project native rows and
finite capabilities atomically; stale projection revisions grant no delegated action.

A directory source stopping preserves independent manual and other-directory access. Full
workspace offboarding retains a local block and rotates every source authorization revision;
provider replay cannot readmit the person. Only an explicit authorized native administrator
can clear that block, projecting currently active sources without reviving old session proof.
Admission control revision is a UI/projection revision, not a shared session epoch: an unrelated
source's update must not revoke a still-current issuing source.

Reuse the pinned native SCIM plugin with verified bearer authority and its native resources.
Acquire the exact workspace lock before SCIM subject mutation. Nested native attempts use SQL
savepoints; canonical initialization, source projection and protocol mutation commit together.
After-commit hooks observe committed state. Narrow transaction-bound capabilities authorize
native initialization and scoped source revocation; ordinary global signout keeps its meaning.
Never delete a target's native sessions while holding the workspace mutex. Directory identity
requires an exact configured claim from the strict verified company token and an active native
link; email, display name and unverified external identifiers never select an existing person.
SCIM profile updates cannot take over an existing global profile, credentials or another
workspace. New-person creation preserves native domain and approval policy. Retain immutable
directory/source proof classification through browser and native handoff and deferred output;
missing or stale provenance never becomes independent authentication.

`WORKSPACE_PROVISIONING_READY=false` is a separate operator attestation for all API, scheduler,
CLI and deferred-output readers. New administration and directory activation additionally
check the distinct live API provisioning capability registry. Policy-only capability and
`WORKSPACE_ACCESS_READY` cannot enable provisioning. Initialized access and source revocations
remain authoritative when new administration is disabled. Keep capable readers and enforce
current migration history for deferred jobs; an old reader is not a safe rollback.

**Rejected.** A parallel organization store; automatic email linking; global session deletion
on source-only changes; directory replay clearing local offboarding; custom owner/admin roles;
permissions that silently add private-channel visibility; clearing retained origin on deletion.

**Cost of reversing.** Preserve retained provenance and epochs until all readers understand any
replacement. Add migrations and migrate deliberately; never reinterpret directory-origin proof
as manual access or edit applied migration history.
