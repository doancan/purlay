# D-28. In the cloud we are the processor; a self-hoster remains their own controller

Amended 2026-09-09. The original decision said the project processes nobody's data and would not
publish a DPA. That was correct for MIT-licensed software somebody else runs. It is **wrong for a
service we operate**, and the two cases now have to be answered separately.

**Two postures, one document set.**

**Cloud — we are a data processor.** The customer is the controller of their team's messages; we
process on their instructions. That is a contractual relationship, so it needs the contract:

- A **data processing agreement**, offered as standard terms and signable without negotiation.
- A **subprocessor list** that is real and maintained — hosting, object storage, transactional
  email, payments, error tracking. Customers are notified before one is added.
- **Retention and erasure become obligations we perform**, not runbooks we hand over (D-27).
- **Breach notification** with a stated timeline, and a record of processing activities.
- Data residency is single-region and stated up front, because D-1 refuses multi-region.

**Self-hosted — the operator is the controller and we are not a party at all.** Unchanged from the
original decision: the project processes no personal data and signs nothing. What ships is what an
operator needs to write their own contract — a **data map** (every table holding personal data,
what it holds, why, how long), a **retention runbook**, an **erasure runbook**, and a statement
that the project itself has no subprocessors.

**Certification.** Still not a programme, and still not an engineering preference: a SOC 2 or
ISO 27001 effort begins when a customer contractually requires one and is budgeted as the business
cost it is. Starting one speculatively is exactly the non-product work D-1 phases against.

**Rejected — one posture covering both.** A single document that tries to describe our obligations
and the self-hoster's at once would be wrong in both directions: it would promise self-hosters
guarantees we cannot give about their own server, and it would let cloud customers think our
obligations end at documentation.
