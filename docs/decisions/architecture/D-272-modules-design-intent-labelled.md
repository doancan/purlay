# D-272. What `MODULES.md` described and nothing built is design intent, labelled so, and built with the first module that needs it — amends `MODULES.md` §3, §4, §7, §8, §10 and §12; builds on D-250, D-254

**Context.** An audit of `MODULES.md` against `main` found sentences that read as built or enforced and are not: a domain
event that the manifest calls a hint or a fact, with a fact also written as a row in the same transaction and drained by a
sweeper; the ports `NotificationSink`, `SearchSource`, `SystemMessagePort` and `AttachmentOwner`; a `register` call a module
makes at boot and `capabilities.has`; `Topic` taking module prefixes from a registry and `ServerFrame` split per module; a
deadline per search source. The domain bus itself exists and is tested, and nothing publishes or subscribes on it. Two modules
exist, and neither has a fact to lose, a notification to send through a port, a capability to ask for, nor a frame of its
own: the issues module was decided to have none of these (D-254 §1). The text was written as the plan of D-250, before
the modules showed what they needed, and a plan read as a description sends the next author looking for a guard that is not
there.

**Decision.**

1. **These are not built, on purpose.** *(Amended 2026-11-07, D-283 §8: the outbox, the ports `NotificationSink` and
   `SearchSource` and the fact and capability fields of the manifest are decided and built ahead of a production consumer of
   the outbox, on the owner's decision; the rest stands.)* Each is built in the change that adds the first module that needs it, with its
   consumer, its test and its mutation, and not before (YAGNI): an outbox and a sweeper with no fact to carry is a table and a
   loop nobody can show is right; a port with one caller and one implementation is a layer.
2. **`MODULES.md` says so where it says anything about them.** §4 has one heading, *Not built (design intent, built with the
   first module that needs it)*, that lists them; §3, §7, §8, §10 and §12 point at it, and a line of §8 for one is marked
   **not built** and is not a guarantee. A statement about any of them elsewhere in the file that reads as built is a bug of
   the document, as a contradiction of `DECISIONS.md` is (`CONTRIBUTING.md`, the conflict rule).
3. **What is built stays said as built, and as far as it goes.** The domain bus is built and has no consumer. The wire
   unions are held by tests where they exist (`NotificationType` and the database's enum to the manifests, every frame and
   event name to one owner) and not opened.

**Rejected.** *Building them now so that the text is true*: each is a decision about a consumer that does not exist, and the
first real one would likely change it. *Deleting the text*: it records what D-250 intended and what a third module
will want to start from. *A flag or a stub that makes the sentence true*: a guard that guards nothing.

**Cost.** None at run time. A reader meets a labelled list in place of a promise. **Cost of reversing:** build one and move
its entry from that list to the rows of §8 in the same change.
