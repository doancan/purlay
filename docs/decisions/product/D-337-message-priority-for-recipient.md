# D-337. A message may ask more of its recipient: priority, only where there is somebody to ask (#1381)

**Context.** Some messages cannot wait (an incident, "the release is blocked on you"). Teams lets the sender pick Standard, Important or Urgent, and re-alerts an urgent one until it is read. Purlay's reasons to tell a person (D-99) said nothing of how much a message matters, and a sender who needed more had to ring somebody.

**Decision.**
1. **A message has a priority**: `normal` (the default), `important` or `urgent`, `messages.priority` with a `CHECK` on the three values. The contract's `SendMessageRequest` and `MESSAGE_SEND` carry it optionally; `Message.priority` is present only when it is not normal and never on a tombstone, so a client from before it draws a normal message.
2. **Only where there is somebody to ask.** A non-normal priority is accepted in a direct message, or when the body names at least one person who can see the channel (mentions resolved in the send's own transaction). Anywhere else it is `400 VALIDATION_FAILED` on `priority` and the transaction rolls back. It can never page a channel: `@here`, `@channel` and `@everyone` are already refused (D-12). A reply is under the same rule. An edit never changes it, and a retry returns the message as it was first written (D-8).
3. **Urgent respects Deep Work** (decided by the owner, 2026-11-25): it waits as any message does, and is not pushed through it. Whether it should pass, as a workspace setting, is a later decision.
4. **First slice only:** the field, the rule, the composer's *Delivery* choice (offered only where the rule would accept it) and the marker under the message. Not in it: the server-scheduled re-alert (every 2 minutes for 20 minutes until read, stopped by a read on any device), the workspace setting that turns urgent off, the inbox and notification marker, and a client's persistent banner.
5. **Workspace control.** A workspace owner or admin can turn off new Urgent sends in General settings. The setting defaults to enabled for existing and new workspaces. Every member gets the setting in their membership. The server applies it to HTTP and socket sends, and a change tells members to refresh. An urgent send committed before the change keeps its priority, including when retried. Standard and Important remain available under the delivery rules above.
6. **Device re-alerts.** D-358 defines the durable schedule and delivery checks.

**Rejected.** *Priority on any channel message:* it pages everybody, which is what a mention is for and a channel is not. *A new notification reason (`urgent`):* the reason says why you were told; how much it asks is a property of the message, which a later schedule can read. *Passing Deep Work by default:* the product's promise is that Deep Work is quiet (D-106); a sender's choice must not be able to break it.

**Cost of reversing.** Low until the schedule exists: a column with a default, an optional field and a marker.
