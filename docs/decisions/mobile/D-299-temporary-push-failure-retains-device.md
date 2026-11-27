# D-299. A temporary push failure retains a live device, and a delayed success changes only its own session — amends D-126

**Context.** A real-SQL reproduction on the installed sender removed a subscription after HTTP 429, 500 or 503
reached its failure limit. The browser still considered itself subscribed; the server would never try that device
for a later message. A success arriving after the subscription changed accounts or sessions also cleared the new
owner's failure streak. The regression suite first failed in both cases.

**Decision.** A temporary provider response, a timeout or a transport failure records a bounded streak and leaves
the device registered. The SQL caps the old value before adding, so even a restored maximum integer cannot
overflow. A later successful delivery resets the streak, under the same subscription, user and session guards
as a failed delivery. Refused server requests remain separate diagnostics, not a fault of the browser. Definitive
404/410 expiry and an endpoint outside the address policy still remove a subscription; sign-out, session expiry
and the device-count bound remain unchanged. Every temporary failure is still counted and logged by its existing
module, without an endpoint, key or message body.

**Rejected.** *Unsubscribe after a provider outage:* an outage says nothing about the browser's subscription.
*An ever-growing counter:* a restored streak can overflow its integer, and another digit does not help diagnose
a continuing outage. *Silently retry in this patch:* retries need their own delivery identity, persistence,
bounds and renewed authority checks; retaining a device promises later messages can try it, not that this
failed message was delivered. Reliable retries and mobile delivery remain part of the requested broader work.

**Verification.** Real SQL and the actual sender, with only the external push service controlled, cover retained
429/500/503 subscriptions, repeated network/timeouts, a large restored streak, later successful delivery, module
metrics, definitive expiry and owner/session changes during a request. Fault mutations remove the retention,
counter bound and response-ownership guard. No migration, dependency, infrastructure or verification threshold
is changed.

**Cost of reversing.** Restore the previous delivery policy; existing rows need no conversion.

**Amended by D-307:** accepted browser delivery work, per-device attempts and admission now survive
restart in PostgreSQL; RAM wake-ups no longer own the work. Current source/device authority is checked
on every bounded attempt, and disabling cancels accepted work without cascading through busy devices.
