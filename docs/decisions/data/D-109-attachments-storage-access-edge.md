# D-109. Attachments: what is stored, who may read it, and the edge that lets 25 MiB in

D-16 ships attachments in Phase 1; `ARCHITECTURE.md` §9 gives the flow; the spikes chose Garage and
Bun's `S3Client` (`docs/spikes/object-storage.md`) and `Bun.Image` (`docs/spikes/image-pipeline.md`),
nothing installed. An adversarial review of the first plan found the edge, memory and tenancy questions
below unanswered. Decided in the owner's standing instruction to decide and proceed, each on the
restrictive side, and open to their reversal. Served by #53, #54, #111, #369, #370.

**1 · An image is stored re-encoded, never as uploaded.** PNG, JPEG, GIF and WebP — recognised by their
bytes, the declared type never trusted — are decoded, turned upright, downscaled to at most 2560 pixels
on the longer side (never up), and stored as WebP; the thumbnail is the same, at 512. The re-encoding is
what strips EXIF (GPS position, camera serial — the spike), and it is the condition D-39 §3 sets for
serving an image inline. Anything else is a file: stored as sent, always served as
`application/octet-stream` with `Content-Disposition: attachment`. An SVG is such a file: downloaded,
never drawn — "never served as SVG" (D-39 §3) by the same rule as every other non-image.

**2 · Memory is bounded before a decode, not after.** A side of at most 16384 pixels and at most 40
million pixels, read from the header before decoding (`Bun.Image`'s own default is a backstop, not the
bound); at most two decodes at once per node. A 25 MiB PNG can decompress to gigabytes; the size limit
bounds the wire, these bound the process. The numbers are bound to the database's CHECKs by a test.
*Measured 2026-10-12 (Bun 1.4.2, macOS arm64), one 40-million-pixel PNG re-encoded at a time and
several at once: +118 MiB RSS for one decode, +258 MiB for two, +450 MiB for four, 136–158 ms each.*
Two keeps a node's peak near a quarter of a gigabyte above its idle; a freed slot is handed to the next
waiter, never given back, so a newcomer cannot make it three. *Amended by D-170:* at most eight wait,
and the image proxy holds at most one of the two.

**3 · `POST /api/workspaces/:workspaceId/uploads?id=&name=`, raw bytes, `application/octet-stream`.**
The workspace is the quota's axis; there is no channel until the message. `id` is a UUIDv7 the client
chose, so a retry after a timeout finds the row it made (D-33's rule); `name` is the file's name, at
most 255 characters with no control or bidirectional-override characters. The body is the file's
bytes with exactly `application/octet-stream` — not `multipart/form-data`, which a cross-site form can
send: D-39 §2's defence is that a form cannot send the type, and this keeps it with a type a form cannot
send either. A missing type is still refused. The route reads no body (`parse: 'none'`) until the
session, the membership and `Content-Length` (required; at most `attachment_size_limit`) have passed, and
then reads it with a cap: 25 MiB is never buffered for somebody who is not let in.

**4 · Every other request keeps the 64 KiB edge.** The server's limit rises to what an upload needs; a
JSON route refuses a body over `JSON_BODY_MAX_BYTES` by its `Content-Length`, and a bodied request with
no length (chunked) with `411`, before it is parsed (D-80's promise, kept by a different mechanism).

**5 · Quota and orphans.** An upload is refused (`413 STORAGE_QUOTA_EXCEEDED`) when the workspace's
`storage_used_bytes`, plus what is uploaded and not yet attached, plus this file, would pass
`storage_quota_bytes` — checked and inserted under a lock on the workspace row, with the object written
*outside* the transaction so no pool connection waits on the store. A person holds at most 20
unattached uploads per workspace and may delete their own; the sweeper of the rest is #71's. *Amended
by D-141:* a discarded or swept upload's objects are queued with its row's delete and tried again until
the store lets them go.

**6 · Who may read one.** The uploader, while it is unattached; afterwards whoever can see the channel
of its message (D-34) — and nobody once that message is deleted (D-103 §7: the tombstone hides what was
said, and what was shown with it). One guarding query, one refusal (`404 ATTACHMENT_NOT_FOUND`), as
`requireMessageById` (#200). An attachment belongs to its message's workspace by a constraint, not by
care (D-90). Downloads carry `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, a sandboxing CSP,
an RFC 6266 file name, and `Cache-Control: private, max-age=31536000, immutable`: the bytes behind an id
never change, and the cache is the person's own. *Amended 2026-10-31 by D-231 §3:* `private, no-cache` with
a tag — a copy is used only after the server has said again that the reader may have it.

**7 · A message may be its attachments alone.** A pasted screenshot needs no words; the words become
optional only when there is at least one attachment, at most 10 per message.

**Rejected: the original kept beside the re-encoding.** It is the copy that leaks GPS, and nothing in
the product shows it. **Rejected: `POST /api/uploads` with `multipart/form-data`** (the earlier
`API.md` row): the form type the CSRF defence exists to refuse. **Rejected: a channel-scoped upload
route.** `attachments` has no channel; the scope would mean nothing the schema can hold.

**Amended 2026-10-12 (#54, sending them) — the edges §7 left unsaid**, decided in the owner's standing
instruction to decide and proceed, and open to their reversal:
- **Linking.** A send names `attachmentIds`; each must be the sender's own, unattached, in this
  workspace. Any other — unknown, somebody else's, already sent, another workspace's — is one
  `404 ATTACHMENT_NOT_FOUND` that tells them apart for nobody, and the message is not written. Two
  sends racing for one upload: one has it, the other is that refusal.
- **No words, nothing attached** passes the contract and is refused by the service as `400` on
  `content`. *Rejected: a union of two shapes in the contract*, which says the same rule in the type
  but reports a refusal as the whole body, so a client cannot point at the field.
- **A retry with the same message id** answers the stored message, whatever ids it names (D-8): what
  it carried was decided by the send that wrote it.
- **An edit still needs words.** A message sent with no words can be given some; a message's words
  cannot be emptied by an edit, whatever it carries. Removing an attachment is not an edit.
- **The count.** Linking moves the bytes onto `storage_used_bytes` in the send's transaction
  (`SCHEMA.md` I-7). Deleting the message does not lower it: the bytes are still stored, as its words
  are (D-9), and the orphan sweep (#71) takes only uploads nobody ever sent.
**Accepted, stated:** the S3 adapter is exercised against Garage locally and in the deployment's smoke
test, not by CI, which runs PostgreSQL alone (`CONTRIBUTING.md` §2); the store is a port, and every
test of the rules runs against a double.


**Amended 2026-10-12 (#388): an upload says how far it has got.** `fetch` reports nothing of a request
body until the answer, and a streamed body would be chunked, which the edge refuses (`411`). So an
upload alone goes over `XMLHttpRequest` (`http.upload`), whose `upload.onprogress` reports the bytes
sent; its answer and its failures are read by the same two functions a request's are (`answerOf`,
`failureOf`), so the second transport cannot believe what the first would refuse. The chip says
*Uploading… 42%* as a `progressbar`. Not measured on a link, and not needed to be: at 2 Mbit/s up,
`ATTACHMENT_BYTES_MAX` is about a hundred seconds, which a word that never changes cannot fill.
