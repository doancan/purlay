# D-302. A missed-mail claim survives a worker restart and keeps earlier unsubscribe links valid — amends D-240, D-297

**Context.** A real child process exiting after the committed notification marks reproduced permanent
mail loss: the next worker saw no unmailed rows. Retrying ambiguous SMTP failures also deleted the
old letter's stop link even when the relay might already have accepted it.

**Decision.** Chat owns an additive `missed_mail_claims` table keyed by letter id, with at most 200
notification ids and a five-minute lease, longer than the relay's bounded waits. A non-null lease is
pending; a null lease retains a released attempt. No row means a legacy or settled letter, so upgrades
never replay historical mail. A pending claim blocks a second composition for that person. Only
settled letters spend the hourly slot. Each lease starts at composition, not at the start of a large job.

Before retention, the job recovers at most 100 expired claims in deadline order under each person's
row lock, with `SKIP LOCKED`. Releasing changes only a still-pending claim and restores only that
person's captured notifications whose `mailed_at` still equals the letter's `sent_at`. A late result
cannot settle a released claim or a replacement. Pending claims are excluded from retention, even
after a long outage; released markers and old stop digests follow thirty-day letter retention.

Before each SMTP handoff the current account, address, opt-in, unread state, channel access, guest
history and quiet policy are checked again. SMTP stays outside SQL transactions. Success or a
permanent addressing refusal deletes only its pending claim. Other transport failures release it;
an acknowledgement that cannot commit remains pending for recovery and makes the job fail. Other
recipients continue after a transport or acknowledgement failure. Stable Message-ID remains derived
from notification ids: delivery is at least once, and a relay acceptance followed by a crash may repeat.
No raw unsubscribe token, recipient address or composed body is added to stored delivery state.

**Rejected.** Replaying all historical letters; marking delivery complete before SMTP; keeping raw
stop tokens; deleting an ambiguous attempt's working stop link; claiming SMTP can provide exactly-once
delivery; extending the existing in-memory push queue and calling it durable.

**Cost of reversing.** Stop new mail processing and retain the additive table. Older code can still
read legacy letters, but cannot recover pending claims. Do not remove the table or rewrite an applied
migration; the durable push and native/mobile acceptance work remains separately tracked in the goal.
