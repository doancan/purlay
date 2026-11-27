# D-173. A workspace's storage is shown to its owners; its quota stays the operator's

**Context.** D-16 caps uploads per workspace, and the cap is enforced (`modules/attachments/uploads.ts`)
— but nothing showed it: an owner learned of it when a file was refused, and only SQL changed it.
`CONFIG.md` said the quota "varies per workspace" and not how. Decided under the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Owners see it**: `GET /api/workspaces/:workspaceId/storage` answers `StorageUsage`, the bytes used
   and the quota, and Settings → Data & retention shows a meter with the numbers ("1.2 GB of 5 GB"),
   what is left, the warning tone from nine tenths and the danger tone with a sentence once it is full.
   An owner's, as retention and exports are: it is what the workspace costs the operator.
2. **One reading for both.** *Used* is the stored bytes and the uploads still waiting to be sent, the
   sum the upload check refuses by — the same function (`modules/attachments/quota.ts`) — so the meter
   never says there is room a refused upload then denies.
3. **The quota is the operator's**, not the owner's: it is their disk. It is set with
   `bun run storage:quota <slug> [<size>]` (`CONFIG.md`), whole bytes or binary units; a quota below
   what is used deletes nothing and refuses uploads until there is room. There is **no in-app control**.
4. **A change is on the trail** *(amended 2026-10-20)*: `storage.quota_changed`, `from` and `to` in
   bytes, written in the command's transaction with no actor — the operator is nobody in the workspace,
   as with the nightly purge (D-139 §3) — and said on the audit log in the reader's units. The same
   quota again writes nothing. An owner whose uploads start being refused can see when the cap moved,
   and to what, without asking the operator.

**Rejected.** *An owner raises their own quota* — the cap exists because self-hosters pay for the disk
(D-16); a control the person who does not pay can turn is not a cap. *An instance-wide default in an
environment variable* — the quota is per workspace, and a default is already the column's.
*A documented `UPDATE` instead of a command* — it takes no lock, so an upload in flight could pass
against the old quota, and a typo in bytes is silent; the command parses and locks.

**Cost of reversing:** a route, a card and a command; no table changes shape.
