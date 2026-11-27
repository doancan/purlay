# D-15. Deep Work is a server-side state, not a client toggle

Previously `is_deep_work_active` existed in the schema with no definition anywhere.

**Defined:** when active for a `workspace_member`, the server **suppresses notification
delivery** (rows are still written, so nothing is lost and a digest is possible later); the
client silences sounds and badges. It is stored server-side precisely so it holds across
devices and so the *server* stops pushing — a purely client-side mute would still wake a phone
in Phase 2. Optional auto-expiry timestamp so it cannot be left on forever.
