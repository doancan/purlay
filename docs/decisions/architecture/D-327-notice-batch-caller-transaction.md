# D-327. A notice to many people is one batch in the caller's transaction, and the cap is kept for each of them — builds on D-286

**Context.** The sink wrote one notice per call: a workspace check, a membership read, an insert, an update for the cap and a push enqueue, each a round trip inside the caller's transaction. A notice that reaches a whole workspace would hold that transaction, and the locks it took, for five round trips per person.

**Decision.**

1. **`notifyMany` and `notifyManyIn`** on the `NotificationSink` port take a list of notices and keep every rule of `notify` and `notifyIn` for each: the kind is the calling module's own (a wrong one refuses the whole batch, nothing written), the one acting is not told, only current members are, and a stopped module or a workspace that lost it writes nothing. `notify` is a batch of one, so there is one code path.
2. **A fixed number of statements, whatever the number of people:** the workspace read, the membership of every recipient in one read (locked in `user_id` order, so two fan-outs to overlapping people lock the same way round), one `INSERT … ON CONFLICT` for every notice, one `UPDATE` that reads each person's unread beyond `UNREAD_PER_MODULE_MAX` as history (`row_number()` over each person's unread of the module, newest by id), and the push enqueue. All in the caller's transaction, so a rollback leaves none of them.
3. **One subject once per person in a batch**, the later notice winning, as two calls one after the other would: a second row of one subject would make the insert's `ON CONFLICT` touch one row twice, which Postgres refuses.
4. **A person's collapse is answered once**, on the first of their notices in the batch, so `purlay_inbox_collapsed_total` counts the rows read as history and not that number times the person's notices.

**Rejected.** *A loop over `notify`*: the round trips this removes. *A cap per notice inside the insert* (a trigger or a CTE per row): the same work in a form a reader of the sink cannot see. *Batching the push's per-person advisory locks*: the push queue's own bound (D-286 §9), out of this change; with web push on, the enqueue still takes one lock per person.

**Cost of reversing.** Two port members, the batch in `modules/inbox/sink.ts` and its tests; no data.
