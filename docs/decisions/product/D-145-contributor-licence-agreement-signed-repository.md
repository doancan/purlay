# D-145. The contributor licence agreement: a licence grant, signed in the repository — #122

**Context.** D-24 requires a CLA on every outside contribution before contributions open, so the
copyright holder can keep offering a commercial licence beside the AGPL. It left open which
agreement, how it is signed, and how an unsigned pull request is stopped.

**Decision.**
1. **A licence grant, not an assignment.** `CLA.md` is the Apache Software Foundation's Individual
   CLA v2.2, the most widely used and read agreement of its kind, changed only where the Foundation
   is not a party: the Maintainer is the copyright holder `NOTICE` names, the nonprofit clause goes,
   and section 2 says outright that the sublicence extends to other terms — the right D-24 needs.
   The contributor keeps their copyright.
2. **Signed in the repository.** The contributor adds their GitHub login, name, the agreement's
   version and the date to `.github/cla-signatures.json`, in their own pull request; the entry, made
   under their own account, is the signature, and the history is the record. A new version of the
   agreement is signed again.
3. **Held by the pipeline.** `bun run check:cla` runs in the `verify` job, which merges require: the
   author is a maintainer (the owners `CODEOWNERS` gives the whole repository), Dependabot, or has
   signed this version; and a pull request adds no signature but its author's own, and removes none.

**Rejected.** *Copyright assignment* — it asks more than D-24 needs and keeps contributors away.
*The Developer Certificate of Origin* — it certifies where the code came from but grants no right to
relicense, which is the point. *A hosted CLA service* (CLA Assistant and its kind) — a third party
holding the signatures and a GitHub app with write access, for what a file and a check already do.
*Writing an agreement of our own* — a legal text nobody has tested is worth less than one that a
generation of contributors and lawyers has read.

**Cost of reversing:** the file, the check and the pipeline step; signatures already given stand.
