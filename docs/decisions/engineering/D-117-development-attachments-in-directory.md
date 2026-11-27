# D-117. Development and the browser suite keep attachments in a directory — closes #387

The browser suite and `bun run demo` start the API with no bucket, so every upload there was a
`503 STORAGE_UNAVAILABLE` and the attachment path — pick, upload, send, see — had never run in a
browser. Decided in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided: `STORAGE_DIRECTORY`, a store that is a directory, for anything but production.**
1. **Production refuses it**, as it refuses to start without the bucket; set with the `S3_*`
   variables it is refused too — one store or the other, never a quiet choice between them.
2. **A key is checked before it is a path** (segments of letters, digits, `_`, `-` and inner dots):
   nothing outside the directory is read or written, whatever a key holds.
3. **The demonstration uses it when no bucket is configured**, a directory per run thrown away with
   the run's database; with a bucket configured (`bun run db:up`) it uses the bucket.

**Rejected: Garage in the browser suite.** The S3 adapter is already tested against Garage as the
deployment runs it (`bun run test:storage`, D-109); what the browser suite asks is whether the path
through the client and the API works, which a directory answers without a second service in every
run and in CI. **Rejected: an in-memory store** — the demonstration's API and its seeding are separate
processes, and a demonstration restarted mid-session would lose what it showed a moment before.

**Accepted, stated:** the browser suite does not exercise S3 itself; `test:storage` does, by hand,
against the real one.
