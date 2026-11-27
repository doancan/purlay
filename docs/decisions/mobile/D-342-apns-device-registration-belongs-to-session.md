# D-342. An APNs device registration belongs to the session that registered it (#1559)

**Decided.** Store one APNs token per live session in `apns_subscriptions`. Registration and removal
recheck the session inside the transaction. The session's foreign key removes its token at sign-out or
expiry cleanup. A token can belong to one session at a time. A second live session receives a generic
refusal, and the token becomes available again when the owning session ends. A registration refresh
or rotation records a new timestamp and generation. This gives the provider's delayed response a
specific registration to act on. Removal matches both the owning session and the token, so a request
for an old token leaves its replacement alone.

Registrations are scoped to the Apple team, topic and environment. Rotating the signing key keeps
registrations in that scope. Each person can register up to 20 live APNs devices. At the limit,
an existing device can renew and adding a device requires freeing a slot. The same occurrence
and per-person budgets cover both providers.
The worker checks the currently configured scope and registration generation before offering an
APNs delivery. An invalidation applies only to the leased generation and only when Apple's
invalidation timestamp is at or after registration. Web Push can be disabled while the APNs
deliveries of the same occurrence continue.

**Cost of reversing.** Dropping these registrations asks iOS devices to register again. Each device's
Web Push subscription has its own store and keys.
