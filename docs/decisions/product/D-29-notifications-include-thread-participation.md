# D-29. Notifications include thread participation — revises D-12

> **Amended 2026-10-19 by D-161.** A person can follow a thread they have not written in, and let go
> of one they have; a choice stands until they make another, and replying again does not undo it.

D-12 restricted notifications to a direct `@username` or a DM, while `SCHEMA.md` shipped a
`notification_type` enum containing `thread_reply` and `thread_resolved`. A direct contradiction,
and the resolution matters because it sits on the product's central claim.

The failure case is concrete. Alice asks why the retry backoff is four seconds. Bob answers in
the thread and does not write `@alice`, because nobody writes a mention inside a thread they are
already in. Alice never learns her question was answered. "Threads that end in an answer"
(`PRD.md` §4.2) does not survive that.

**Decided: a third notification class — participation.** A new reply notifies the root author
and everyone who has already replied in that thread. Resolving notifies the root author when the
resolver is somebody else.

This does not weaken "quiet by default". That tenet is aimed at **broadcast** — which is why
`@here` and `@channel` are rejected by the parser, and that stays absolutely unchanged. An
answer to a question you asked is not an interruption; it is the thing you were waiting for.
Deep Work (D-15) still suppresses delivery, and a channel set to `notification_level = 'none'`
still silences it.

Participants are resolved with a bounded `DISTINCT sender_id` over `idx_messages_thread`, which
is one indexed lookup per reply — not a scan.

**Rejected:** notifying only the root author. In a three-person discussion the second and third
participants would silently lose the conversation they are in, which reproduces the original bug
one seat over.
