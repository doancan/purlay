# D-297. A missed-mail letter is sent at least once, a repeat is recognisable, and an address the relay refuses for good is not tried again — builds on D-240; amends D-240

*Amended by D-302: durable claims recover after a worker restart and retain earlier stop links.*

**Context.** D-240 said a letter is never sent twice and, in the same paragraph, that a letter the relay refused has its rows given back for
the next run. Those two cannot both hold. A failure after the relay has the letter (a socket timeout while it waits for the answer, a
connection closed after the end of the data) cannot be told from one before it: nodemailer labels both with the same `CONN` stage and a code
such as `ETIMEDOUT` or `ESOCKET`. Giving the rows back is the right answer to a relay that is down or unreachable, which is the common
failure and would otherwise lose every person's letter for the length of the outage; it also means the rare ambiguous failure sends the
letter again. The code already did this; the document said it did not. Separately, an address the relay refuses for good was given back
and refused again every quarter hour for ever, failing the run each time, and a failure to give one person's rows back ended the run for
the people after them.

**Decision.**

1. **Delivery is at least once.** The claim (`mailed_at` set under the person's lock) still makes two runs at once send one letter, once.
   After the commit a failure of any kind but the one in item 3 gives the rows back, as before. The comment of `missed-mail.ts` and D-240's
   "never twice" now say what is true: never twice by two runs, once more at most after an ambiguous failure.
2. **A repeat is recognisable.** Every letter carries a `Message-ID` made from the ids of the notifications it is about
   (`<missed-<32 hex of SHA-256>@<host of APP_URL>>`), so the same rows sent again carry the same one and a mailbox that deduplicates on it
   (Gmail does, within an account) shows one letter. Other mail clients may show two; that is the cost of item 1 and is not hidden. A letter
   about other rows, which is a different letter, has another one. `MailMessage.messageId` is optional and the relay makes one where it is
   absent.
3. **An address refused for good is not tried again.** A 5xx reply carrying an addressing status, RFC 3463 `5.1.1` to `5.1.3` (no such
   mailbox, no such domain, a bad address), means this person's address, and no later run will be taken. Its rows stay marked, the run does
   not fail for it (`refused` is counted beside `letters` and `failed`) and the log says so with the relay's code only. A bare `550`
   is **not** enough: `550 5.7.1 relaying denied` is the relay's own, would be said to every person, and would lose every letter on a
   misconfigured relay. A relay that sends no status is taken to be the trouble and the letter is tried again.
4. **One person's failure is that person's.** A failure to give rows back is logged and counted, their letter is lost as after a crash, and
   the people after them are mailed in the same run.

**Rejected.** *Keeping the rows marked on any ambiguous failure ("never twice"):* the ambiguous codes include the connection timeout of a
relay that is down, so an outage would lose the letter of everyone due in it, a worse outcome than a rare repeat for a message about what
a person missed. *Telling the two apart by the error:* measured in nodemailer 10.3.1 (`smtp-connection`), a socket timeout and a closed
socket are reported as `CONN` whatever stage they happen in, so the stage is not available. *A per-letter attempt counter or a state
machine in the database:* the address-refused case was the unbounded retry, a counter would add a migration for the rest, and a relay
down for days is the operator's to see in `jobs:status`. *Treating every `550` as the address's:* item 3.

**Cost of reversing.** None for the data: no column was added. Drop the `Message-ID`, the refused-address branch and the isolation of the
give-back and the behaviour is D-240's as it ran before.
