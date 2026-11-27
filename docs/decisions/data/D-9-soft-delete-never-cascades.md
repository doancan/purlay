# D-9. Soft delete never cascades

`messages.parent_id` becomes `ON DELETE RESTRICT`. The previous `ON DELETE CASCADE` directly
contradicted the stated soft-delete policy: hard-deleting a parent would have silently
destroyed an entire resolved thread — exactly the knowledge loss Purlay exists to prevent.

Deleting a message sets `deleted_at` and clears `content` to a tombstone. Threads survive
their parent. Hard deletion happens only via an explicit operator-run purge job.
