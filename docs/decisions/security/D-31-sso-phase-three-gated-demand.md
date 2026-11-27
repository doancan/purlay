# D-31. SSO moves from permanent non-goal to Phase 3, gated on demand

`PRD.md` §6 lists SSO/SAML as permanent. D-25's ceiling and D-26's audit log describe an
organisation that has an identity provider; keeping "never" alongside them is an internal
contradiction, and a permanent non-goal that is contradicted by another decision teaches readers
that the non-goal list is negotiable — which would damage the entries that genuinely are
permanent.

**Decided: OIDC, Phase 3, only if an operator asks.** Not SAML: SAML is XML signature handling
and a decade of parser vulnerabilities, for the same outcome at roughly ten times the cost.
`users.github_id` is already nullable (D-11) and `email` is already the identity anchor, so the
schema does not change.

The rest of `PRD.md` §6 is unaffected and stays permanent.

**Amended 2026-09-09.** "Gated on demand" now has a concrete demander: a cloud customer (D-1)
with an identity provider will ask, and will be paying. The gate is unchanged — it is built when
someone actually asks — but the expectation is that it arrives sooner than Phase 3. This is also
the point at which D-11's hand-rolled session layer stops being the obvious choice: a library that
owns OIDC is worth a dependency, and `better-auth` is the current candidate. `lucia`, a plausible
alternative when D-11 was written, has since been deprecated.

*Amended 2026-10-21 by D-179:* `better-auth` is the library now, for the reasons of sign-in, sessions and
setup, not for OIDC. OIDC is still built only when an operator asks.

*Amended 2026-10-27 by D-200:* the condition is gone and OIDC is built — a third way in beside GitHub and email, with
the linking rule and the checks that make a provider's word believable. SAML stays refused.
