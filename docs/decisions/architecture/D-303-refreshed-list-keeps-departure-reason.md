# D-303. A refreshed HTTP list cannot lose the channel departure reason across reconnect — builds on D-264, D-82

**Context.** Main CI's browser trace showed the refreshed channel list omitting an archived channel before
the socket opened again. The engine correctly stopped watching it, so reconnect never requested D-264's
existing departure proof. The screen could only say that the channel was not there. This is a product
ordering defect, not a reason to retry the unchanged test or lengthen its timeout.

**Decision.** HTTP loss in the same workspace immediately removes pending sends, as before. If the reason
is unknown, an isolated diagnostic subscription requests the existing departure proof without a replay
cursor. It never shares a subscription chunk with current memberships. Ordinary chunk bounds and transient
backoff apply; a refused diagnostic cannot refuse other channels or degrade their content stream.

Every normal watch or departure intent owns an object identity captured by its request. Completion can retire only that intent:
a membership returned and lost again has a new owner. Named departure replies carry their subscription's
id in the existing optional `refId` envelope field. The client drops a correlated proof belonging to an old
intent; legacy uncorrelated revocation remains conservative. Existing clients can ignore the correlation.
A late normal-subscription reply is subject to the same ownership check. A refused batch containing
an obsolete watch rechecks the remaining memberships without discarding their pending sends.
No response restores content or sending authority.

A not-found error is not the end of a diagnostic: its named reason is a separate frame. Keep the intent
until a valid reason arrives or a subsequent correlated PING reply proves that same socket's FIFO reply finished
without one. The server handles inbound frames serially and writes a reply's frames in order. Even a rate refusal of the later PING completes that FIFO barrier. A disconnect
between ERROR, reason and its barrier reply retains unresolved intent for the next socket. An old completion barrier
cannot clear a new loss. This uses existing PING/PONG and no new endpoint or frame shape.

Diagnostic ACK/error frames do not start content replay or advance cursors. Channel content during a probe
or its unsubscribe is ignored. A successful probe is unsubscribed immediately unless membership returned;
normal membership then receives its own cursor subscription. Stop/session end clear diagnostics; socket
generations and account ownership still guard every write. No stored intent, migration or new authority
is introduced. Measured client growth is recorded beside the shell bound; total and module fences remain.

**Proof.** Transport tests drive the HTTP-before-open order, empty/bounded/chunked queues, current-member
batch isolation, content/cursor suppression, membership return, repeated loss, partial reply disconnect,
old ACK/error/reason/barrier, transient failure and stop/session end. The real browser test keeps sockets
down until HTTP has omitted the channel and the generic missing page is visible, then requires the archived
reason after reconnect. SQL tests preserve prior-member-only disclosure and assert reply correlation.

**Rejected.** Retaining membership or its outbox until a socket returns; holding HTTP behind realtime; a
new departure endpoint; diagnostic replay; mixing missing probes with member batches; treating ERROR as
proof that no reason follows; channel-id-only completion; wider browser timeouts or unchanged test retries.

**Cost of reversing.** Remove the diagnostic request and accept the generic missing state for this order.
Keep immediate authority/outbox removal and server departure-proof privacy.
