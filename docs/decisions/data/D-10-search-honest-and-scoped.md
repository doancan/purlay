# D-10. Search is honest and scoped

- ~~Text search config becomes **`simple`**, not `english`.~~ **Removed by D-40:** the next bullet
  drops the `tsvector` entirely, so no text search configuration is left to choose. The reasoning
  survives as *why full-text search went away* — English stemming folds `getUserById` into one
  unsearchable token and is actively wrong for Turkish content.
- The generated `tsvector` column and its GIN index are **dropped for Phase 1**. A GIN trigram
  index alone covers substring and identifier lookup.
- Search is scoped: within a workspace, optionally within a channel, newest-first, paginated.
- The performance claim is removed. Trigram GIN on a hot table costs 3–10× the content size
  and slows every insert — we are not trading message-send latency (the actual wedge) for
  search speed.

Real code search across repositories is a **different product**. Not in scope.
