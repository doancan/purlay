# D-204. Questions keep their answers and decisions; search finds them

*Amended by D-224: Search operators are typed filters, read on the client into the criteria search already takes.*

**Context.** On 2026-10-28 the owner approved research proposals 1–3: accepted answers and decision notes, unanswered questions with ownership, and advanced search with saved searches. This explicitly expands the current phase (D-4); GitHub issue creation is planned separately.

**Decision.** A root may be explicitly marked as a question before it has replies. Existing unresolved threads remain listed. Questions may name a channel member as owner; unanswered and assigned filters and oldest-first pagination expose waiting work. Assignment never sends a notification.

A root may select one live reply from its own thread as its answer, and carry a short plain-text decision note and an optional HTTP(S) reference. Selecting an answer and resolving remain separate explicit actions. A versioned metadata write prevents two editors overwriting each other; an identical retry succeeds. Any current channel member may edit, as with resolution. Deleted roots expose none of these fields; a deleted selected answer exposes no copied content. Notes are included in workspace export and cleared with a root's deletion; operator content erasure also clears notes last written by the erased person.

Search retains literal, case-folded matching and adds resolution/question, date, code/file, and repository filters. It also searches root decision notes and their live selected answers. Saved searches are personal, bounded, server-stored filters, never cached results, and every reuse applies current channel visibility. Dates are inclusive from/exclusive until UTC instants; before remains the UUID page cursor. Repository filters match owner/repo boundaries in GitHub links and repository events.

Contracts expand additively: optional knowledge in ThreadSummary, defaulted message columns, new versioned metadata and saved-search endpoints. Existing resolve routes and old rows remain valid. Metadata updates advance message state_version and changed_at and publish THREAD_UPDATED after commit. No new runtime dependency, notification class, scheduler, AI, or task tracker.

**Rejected.** Inferring questions from punctuation would classify ordinary conversation and miss questions without question marks. Implicitly resolving on answer selection would close discussion without the reader asking. Saving search results would outlive access revocation. Replacing the existing unresolved list would hide old work.

**Reversal.** Revert application changes and retain additive columns/table; do not discard stored decisions or saved filters. The first three capabilities are delivered together as requested; later GitHub integration is a separate scope decision.
