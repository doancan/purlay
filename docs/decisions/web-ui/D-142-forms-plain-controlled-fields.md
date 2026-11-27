# D-142. Forms are plain controlled fields, validated by the contract — #582

**Context.** `CONTRIBUTING.md` §4 said forms use `react-hook-form` and `zod`. Neither was ever a
dependency, and no form used them. Every form in the client — profile, invitations, new channel,
GitHub, incidents — is plain controlled fields, and what a field may hold is the contract's TypeBox
schema, checked by the server, with a refusal said on the field it names. A rule that nothing follows
and nothing checks is a wish (§6.2).

**Decision.** Forms are plain controlled fields. The server's contract is the one validation, and a
`VALIDATION_FAILED` refusal is shown on the fields its `fields` names. A client may check what helps the
person as they type — a required field left empty, a length it shows counting down — from the
contract's own constants, never from a second schema.

**Rejected.** *Keeping the rule* — two dependencies and a rewrite of every form, to add a client-side
copy of each TypeBox schema: a second copy of each shape (§1.4), which would drift from the server's.

**Cost of reversing:** adding the two packages, under §1.12, and moving the forms over.
