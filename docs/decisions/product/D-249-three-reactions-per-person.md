# D-249. At most three reactions a person on a message — builds on D-99 §6

**Context.** A message held at most twenty distinct emoji (D-99 §6), and nothing bounded one person: one
member could put all twenty on a message alone. Every other team chat lets them — Slack's limit is reported as 23 a
person and 50 kinds, Teams 20 a person since June 2025 (one before), Discord and Mattermost bound only the
kinds (20, 50). The consumer messengers allow one (WhatsApp, iMessage, Telegram's free tier; three with Premium).

**Decision.** One person puts at most `REACTIONS_PER_PERSON_MAX` = **3** different emoji on one message
(`@purlay/types`). Three is enough for a reaction that says where a thing stands — 👀 and then ✅ — with one to spare,
and too few for one person to fill a message. The twenty kinds stay.

1. **Refused, not replaced.** A fourth is `400 VALIDATION_FAILED` naming `emoji`, and publishes nothing; the person's
   three are untouched. Reacting again with one of the three is the idempotent answer, as before, and taking one back
   makes room. The person's limit is checked before the kinds', both under the message's advisory lock, so two clicks at
   once from one person cannot both pass the count.
2. **The client says so without asking.** With three of theirs on the message, a fourth is not sent: a toast says the
   limit and how to make room, where the server's refusal would say only that the reaction was not saved.
3. **Rows already there stay.** A person who had more than three before this keeps them; they can take them back, and
   add no new one until they are under the limit. No migration rewrites anybody's reactions.

**Rejected.** *One a person, the newest replacing the old* (WhatsApp's) — reactions in a team chat are a status as much
as a feeling, and one would make 👀 and ✅ exclusive; Teams started there and left it. *Two* — exactly the status pair,
with nothing left for a feeling. *Replacing the oldest at the limit* — a click that silently takes back something else
the person said. *A workspace setting* — a number nobody would tune, and a second answer for every client to learn.

**Cost of reversing.** Change the constant (or delete the check in `reactions.ts` and the toast's guard); nothing is
stored.
