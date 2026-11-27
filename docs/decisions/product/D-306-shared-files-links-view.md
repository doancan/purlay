# D-306. Shared is a current authorized view of conversation files and rendered links — builds on D-129, D-194, D-300

**Context.** Business teams need to find a supplier file, policy or ERP link across conversations,
without another document store. Public previews select only two external candidates and deliberately
exclude intranet addresses; that policy cannot implement a link catalogue.

**Decision.** Add a lazy Shared screen with Files/Links, literal file-name/title/address search and
channel/person/type/local-calendar filters kept in the address. Reuse authenticated file/image/PDF/text
previews and canonical message addresses for roots and replies. Keep source authorization in SQL before
page limits and pending status: current workspace/channel access, strict guest join history, hidden and
deleted rows, archived channels and closed workspaces. No administrator bypass. Bound page sizes and
compound opaque cursors to the current reader, workspace and normalized filters, without requiring a
cursor's source to survive. Links include every rendered HTTP(S) URL, including intranet/ERP links,
without fetching targets; exclude code, credentials and unsafe protocols, deduplicate normalized URLs
and retain their first plain label. Existing public-preview behavior remains unchanged.

Chat owns the projection, a durable pending-source table and one historical cursor. No core column is
added and the worker never updates source messages or their replay timestamps. An INSERT/content,
metadata, type or deletion UPDATE trigger captures every source writer, including a previous node
through a rolling upgrade. A historical interval advances only after its jobs are durably enqueued;
its singleton lock is skipped when held, while source key-share locks use NOWAIT so a locked deletion
cannot become a skipped hole. Workers lock a pending source before its child rows, SKIP LOCKED, parse
current content, replace the projection and clear its job in the same transaction. Historical enqueue
and processing are bounded, restartable and safe on several nodes. Source hard deletion cascades;
tombstones/content erasure clear derived links. Source order and timestamps are untouched.

New application writes keep projection in the source transaction. A nonempty projection uses one DML
CTE to upsert links and clear its pending job; normal text with no links adds no client SQL statement,
preserving the existing eight-statement send bound. Pending projections are excluded from Shared, so
an older writer cannot expose a URL it has already removed. One SQL snapshot returns both the page
and its visible-only coverage: a worker completing between separate reads must not strand an empty
screen with polling stopped. File pages use source/attachment descending; links use source descending
and SHA-256 URL key ascending. Validate real calendar instants before hashing date filters or SQL.

Source arrival/edit and reconnect invalidate Shared. Access changes discard pages and abort older
reads; delete/hide cancels and removes the source immediately, and a source inventory change retires
open preview snapshots. English/Turkish states cover loading, empty/no-match, indexing, error/retry,
stale/offline and bounded load-more. Exports retain ordinary scoped source content and omit derived
links, pending jobs and the internal cursor. The only growing-table index is built CONCURRENTLY outside
a transaction, drop-first for interrupted-build recovery. Applied migrations remain immutable.

There is no new service, runtime dependency or UI primitive. The measured initial shell is 257.24 KB
gzipped versus v0.6.4's 256.87 KB: shared client contracts/copy/cache integration cost 0.37 KB. D-196's measured shell
bound moves from 257 to 258 KB; the 400 KB backstop, module bounds and source-map fences stay.

**Rejected.** Another document library; unbounded history parsing in GET; the public two-preview
extractor; OFFSET/positional URL keys; a new column on a legacy core table; stamping old messages as
edits; cursor advancement past an unqueued locked source; dirty projections; separately observed page
and coverage; stale private preview snapshots.

**Cost of reversing.** Remove the Shared route/rail/palette and worker, stop synchronous projection
and remove capture in a new migration. Leave applied files alone and derived tables inert. Source
messages, attachments and existing file behavior remain intact; no destructive restore is required.
