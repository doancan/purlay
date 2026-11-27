# D-16. Attachments ship in Phase 1

A chat tool you cannot paste a screenshot into is not usable, so this cannot be deferred.

- New `attachments` table, linked to a message.
- Storage behind an S3-compatible interface: MinIO locally, any bucket in production, local
  filesystem for the simplest self-host.
- Per-file limit lowered **50MB → 25MB**. Images are downscaled and thumbnailed on upload.
- Per-workspace quota enforced, because self-hosters pay for the disk.
