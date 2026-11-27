# D-301. Live channel counters survive older list responses under current access — builds on D-99, D-148, D-300

**Context.** A channel list requested before a live message can finish after its newer
`CHANNEL_STATE`. Replacing that cache with the older unread zero suppresses both a first DM alert
and a thread's read receipt. A controlled browser test reproduces the lost badge and missing alert
on v0.6.1 with real HTTP, SQL and sockets. A guest CI trace independently showed a received live
unread one without its UI badge or thread read, but did not retain the cache commit ordering.

**Decision.** Patch the server's live counters and cancel an already pending channel-list read in
favour of a fresh authorized read. Do the same for a channel added to a known list. An unknown
channel is discovered through the existing bounded list refresh; no unowned pending counter map
is kept. Ordinary frames on a settled list make no extra list request. An actual later live read
zero remains authoritative: do not combine counters by their maximum.

Cancellation completion is asynchronous. Capture the real Query identity and its access marker
before awaiting it; refetch only if both still belong to current access. Removal, reset and account
replacement must prevent the old continuation from scheduling new work. Notification preferences,
foreground suppression and native OS permission remain unchanged.

**Rejected.** Dropping the thread-read assertion, assuming native focus implies unread state,
retaining old counters after account changes, and describing HAR completion as a cache commit.

**Cost of reversing.** Revert the client update without a migration or stored-format change. The
controlled stale-response browser and cache regressions remain the acceptance contract.


Unused invitation and device-notification request schema construction uses the existing pure-builder
annotations from the find contract. The browser drops validators it never imports; server routes
and imported response validators retain the same schemas and constraints. Format registration is
not marked pure. Initial/module byte bounds and all measured performance bounds stay unchanged.
